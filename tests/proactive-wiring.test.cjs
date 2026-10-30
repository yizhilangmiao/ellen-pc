"use strict";
// 闸门接进 EmotionScheduler 的接线测试。
// 目的只有一个：证明「本地闸判不过，模型就不会被调、消息就不会发出去」。
// 这条是省钱和「别在睡觉时吵人」的全部依据，接线错了前面两个纯函数再对也没用。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { EmotionScheduler } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
const { ProactiveGate } = require(path.join(__dirname, "..", "src", "proactive-gate.cjs"));

const THREAD = "thread-1";

function makeGate(dir) {
  return new ProactiveGate({
    file: path.join(dir, "proactive-state.json"),
    logFile: path.join(dir, "proactive.log")
  });
}

function makeScheduler(gate, { assessResult, sent, clockRef, emotionPatch } = {}) {
  const emotion = {
    testMode: true,
    data: {
      waiting: null,
      latestReply: null,
      latestUser: { threadId: THREAD, at: new Date(clockRef.now - 9 * 36e5).toISOString() },
      lastProactiveAt: null,
      contactPlan: null
    },
    ensureContactPlan: () => true,
    due: () => true,
    contactReviewDue: () => false,
    persist: () => true,
    sleepingAt: () => false,
    canContact: () => true,
    assess: async () => assessResult,
    view: () => ({}),
    ...emotionPatch
  };
  const service = {
    state: { busy: false, loading: false, retry: false, threadId: THREAD, messages: [] },
    gateway: { configured: true },
    proactive: async (topic) => {
      sent.push(topic);
    }
  };
  return new EmotionScheduler({
    emotion,
    service,
    isEnabled: () => true,
    isBusy: () => false,
    clock: () => clockRef.now,
    setIntervalImpl: () => null,
    gate,
    preset: () => "standard",
    idleSeconds: () => clockRef.idle
  });
}

test("闸判不过：模型不调、消息不发", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-"));
  const gate = makeGate(dir);
  const clockRef = { now: Date.now() + 6e5, idle: 1200 }; // 离开电脑 20 分钟
  const sent = [];
  const sched = makeScheduler(gate, {
    sent,
    clockRef,
    assessResult: { proactive: { send: true, topic: "在忙什么" } }
  });

  clockRef.now += 3e5; // 越过 bootReadyAt / readyAt
  await sched.tick();
  assert.deepEqual(sent, [], "人不在了就不该发");
  assert.equal(gate.data.previousIdleSeconds, 1200);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("闸放行：发出去一次，而且只记一组", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-"));
  const gate = makeGate(dir);
  const clockRef = { now: Date.now() + 6e5, idle: 5 };
  const sent = [];
  const sched = makeScheduler(gate, {
    sent,
    clockRef,
    assessResult: { proactive: { send: true, topic: "今天那个会开完了？" } }
  });

  clockRef.now += 3e5; // 越过 bootReadyAt / readyAt
  await sched.tick();
  assert.deepEqual(sent, ["今天那个会开完了？"]);
  assert.equal(gate.groupsToday(clockRef.now), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("睡眠时段：canContact 直接否掉，不靠原来写死的 9-23", () => {
  const { EmotionRuntime } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-sleep-"));
  const file = path.join(dir, "emotion-state.json");
  const rt = new EmotionRuntime({
    file,
    gateway: { configured: true },
    sleepWindow: { isSleeping: (ms) => new Date(ms).getHours() === 2 }
  });
  rt.seed({ id: "m1", threadId: THREAD, createdAt: new Date().toISOString() });
  rt.data.contactPlan = { userId: rt.data.latestUser.id, mode: "normal", dueAt: new Date(0).toISOString(), followupLimit: 1 };

  const twoAm = new Date("2026-10-30T02:00:00").getTime();
  const tenAm = new Date("2026-10-30T10:00:00").getTime();
  assert.equal(rt.sleepingAt(twoAm), true);
  assert.equal(rt.canContact(THREAD, twoAm), false);
  assert.equal(rt.sleepingAt(tenAm), false);
  assert.equal(rt.canContact(THREAD, tenAm), true);
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("旧的 followupLimit 3/4 仍然能读，不会一读盘就停摆", () => {
  const { EmotionRuntime } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-legacy-"));
  const file = path.join(dir, "emotion-state.json");
  const rt = new EmotionRuntime({ file, gateway: { configured: true } });
  rt.seed({ id: "m1", threadId: THREAD, createdAt: new Date().toISOString() });
  const base = JSON.parse(JSON.stringify(rt.data));
  rt.close();

  for (const limit of [0, 1, 2, 3, 4]) {
    const saved = {
      ...base,
      version: 1,
      contactPlan: { userId: "u1", mode: "normal", dueAt: new Date().toISOString(), followupLimit: limit }
    };
    fs.writeFileSync(file, JSON.stringify(saved));
    const again = new EmotionRuntime({ file, gateway: { configured: true } });
    assert.notEqual(again.readBlocked, true, `followupLimit=${limit} 不该被拒`);
    again.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("台账有到期的事，闸的打分会收到 threadScore", async () => {
  const clockRef = { now: Date.now() + 6e5, idle: 5 };
  const seen = [];
  const spyGate = {
    evaluate: (ctx) => {
      seen.push(ctx);
      return { allow: false, score: 0, reason: "below-threshold", preset: "standard", signals: [] };
    },
    commit: () => {}
  };
  const threads = {
    pressure: () => 4,
    visit: () => true
  };
  const sched = makeScheduler(spyGate, {
    sent: [],
    clockRef,
    assessResult: { proactive: { send: true, topic: "问一句" } },
    emotionPatch: { threads }
  });
  clockRef.now += 3e5;
  await sched.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].threadScore, 4, "台账压力要真的传进打分，否则记的事永远排不上号");
});

test("发送成功后，问过的那件事记一次回访", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-visit-"));
  const gate = makeGate(dir);
  const clockRef = { now: Date.now() + 6e5, idle: 5 };
  const visited = [];
  const sent = [];
  const sched = makeScheduler(gate, {
    sent,
    clockRef,
    assessResult: { proactive: { send: true, topic: "那个会开完了？", threadId: "t1" } },
    emotionPatch: { threads: { pressure: () => 0, visit: (id, at) => visited.push([id, at]) } }
  });
  clockRef.now += 3e5;
  await sched.tick();
  assert.deepEqual(sent, ["那个会开完了？"]);
  assert.equal(visited.length, 1, "问过就要记一次，否则同一件事会被反复问");
  assert.equal(visited[0][0], "t1");
});

test("validate 收下合法台账，非法条目整条丢弃且不阻断心情", () => {
  const { validate } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
  const base = {
    emotions: [{ id: "calm", intensity: 0.5 }],
    reason: "r",
    intent: "i",
    trend: "steady",
    evidenceIds: [],
    proactive: { send: false, topic: "" }
  };
  const ok = validate(
    {
      ...base,
      threads: [{ id: "t1", topic: "他说今天有个会", quote: "今天下午三点开会", kind: "plan", dueAt: new Date(Date.now() + 36e5).toISOString() }],
      threadOps: [{ id: "t1", status: "done" }]
    },
    { messages: [], user: null }
  );
  assert.equal(ok.threads.length, 1);
  assert.equal(ok.threads[0].quote, "今天下午三点开会");
  assert.equal(ok.threadOps.length, 1);

  // 混进烂数据：不抛错，烂的丢掉，好的留下
  const mixed = validate(
    {
      ...base,
      threads: [
        { id: "t2", topic: "没时间的" },
        { id: "t3", topic: "太远的", dueAt: new Date(Date.now() + 30 * 864e5).toISOString() },
        { id: "t4", topic: "正常的", dueAt: new Date(Date.now() + 36e5).toISOString() }
      ],
      threadOps: "不是数组"
    },
    { messages: [], user: null }
  );
  assert.deepEqual(mixed.threads.map((t) => t.id), ["t4"]);
  assert.deepEqual(mixed.threadOps, []);
  assert.equal(mixed.feeling.length > 0, true, "心情不能因为台账脏数据丢失");
});

test("没有台账时，输入里给空数组而不是崩掉", () => {
  const { validate } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
  const out = validate(
    {
      emotions: [{ id: "calm", intensity: 0.5 }],
      reason: "r",
      intent: "i",
      trend: "steady",
      evidenceIds: [],
      proactive: { send: false, topic: "" }
    },
    { messages: [], user: null }
  );
  assert.deepEqual(out.threads, []);
  assert.deepEqual(out.threadOps, []);
  assert.equal(out.proactive.threadId, "");
});

// 台账接线曾经把 return 弄丢过一次：assess 变成返回 undefined，
// 心情完全不更新，而所有只测"台账有没有写进去"的用例都还是绿的。
// 这条专门盯这个：assess 必须有返回值。
test("接上台账之后 assess 仍然有返回值", async () => {
  const { EmotionRuntime } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
  const { OpenThreads } = require(path.join(__dirname, "..", "src", "open-threads.cjs"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-ret-"));
  const reply = JSON.stringify({
    emotions: [{ id: "calm", intensity: 0.5 }],
    reason: "他说下午要开会",
    intent: "记下",
    trend: "steady",
    evidenceIds: ["m1"],
    proactive: { send: false, topic: "" },
    threads: [{ id: "t1", topic: "他说三点要开会", kind: "plan", dueAt: new Date(Date.now() - 36e5).toISOString() }]
  });
  const rt = new EmotionRuntime({
    file: path.join(dir, "emotion-state.json"),
    gateway: { configured: true, complete: async () => reply },
    testMode: false,
    threads: new OpenThreads({ file: path.join(dir, "open-threads.json") })
  });
  rt.seed({ id: "m1", threadId: THREAD, role: "user", createdAt: new Date().toISOString() });
  const out = await rt.assess({
    kind: "reflection",
    user: { id: "m1", threadId: THREAD, text: "三点开会", role: "user" },
    messages: [{ id: "m1", role: "user", text: "三点开会", createdAt: new Date().toISOString(), status: "completed" }],
    canContact: true
  });
  assert.ok(out, "assess 返回了 undefined：心情不会更新，聊天会看起来一切正常但心是死的");
  assert.equal(out.emotions[0].id, "calm");
  assert.equal(out.threads.length, 1);
  rt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
