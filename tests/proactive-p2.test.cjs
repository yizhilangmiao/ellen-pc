"use strict";
// P2 三项体感规则的判定测试：
//   ① 「你回来了」一天最多一次，且不能报时间差（时间差由措辞规则管，这里管次数）
//   ② 深夜（睡前 90 分钟）由入睡点算出来，先问事不劝睡；深夜不发第二条
//   ③ 无回复的「再试一次」——标准档补发从 1 次提到 2 次
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const gateModule = require(path.join(__dirname, "..", "src", "proactive-gate.cjs"));
const schedule = require(path.join(__dirname, "..", "src", "emotion-schedule.cjs"));
const { deepNightAt, evaluate, ProactiveGate, DEEP_NIGHT_MINS } = gateModule;

const THREAD = "thread-1";
const HOUR = 36e5;

function at(hh, mm = 0, day = 30) {
  return new Date(2026, 9, day, hh, mm, 0, 0).getTime();
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p2-"));
}

// ── 深夜窗口 ────────────────────────────────────────────────
test("深夜窗口是环形区间：[入睡前 90 分钟, 入睡点)", () => {
  const sleepStart = 60; // 01:00 睡
  assert.equal(DEEP_NIGHT_MINS, 90);
  assert.equal(deepNightAt(at(23, 29), sleepStart), false);
  assert.equal(deepNightAt(at(23, 30), sleepStart), true);
  assert.equal(deepNightAt(at(0, 30), sleepStart), true);
  assert.equal(deepNightAt(at(0, 59), sleepStart), true);
  assert.equal(deepNightAt(at(1, 0), sleepStart), false);
  assert.equal(deepNightAt(at(22, 0), sleepStart), false);
});

test("入睡点不在跨零点附近也对：08:00 睡则 06:30-08:00 算深夜", () => {
  const sleepStart = 8 * 60;
  assert.equal(deepNightAt(at(6, 29), sleepStart), false);
  assert.equal(deepNightAt(at(6, 30), sleepStart), true);
  assert.equal(deepNightAt(at(7, 59), sleepStart), true);
  assert.equal(deepNightAt(at(8, 0), sleepStart), false);
  assert.equal(deepNightAt(at(20, 0), sleepStart), false);
});

test("没给入睡点就永远不算深夜（推断不出来时宁可不说错话）", () => {
  assert.equal(deepNightAt(at(23, 40), null), false);
  assert.equal(deepNightAt(at(23, 40), undefined), false);
});

test("gate 自己算出 deep-night 信号，不用外部传布尔", () => {
  const base = {
    now: at(23, 45),
    preset: "standard",
    idleSeconds: 5,
    lastUserAt: at(23, 40).toString(),
    groupsToday: 0
  };
  const night = evaluate({ ...base, sleepStart: 60 });
  assert.equal(night.deepNight, true);
  assert.ok(night.signals.includes("deep-night"), `signals=${night.signals}`);

  const day = evaluate({ ...base, sleepStart: 60, now: at(15, 0) });
  assert.equal(day.deepNight, false);
  assert.equal(day.signals.includes("deep-night"), false);
});

// ── 「你回来了」一天一次 ────────────────────────────────────
test("刚回来 +3，但当天已经用掉就不再算", () => {
  const context = {
    now: at(20, 0),
    preset: "standard",
    idleSeconds: 3,
    previousIdleSeconds: 1800, // 离开半小时后回来了
    lastUserAt: at(19, 0),
    groupsToday: 0
  };
  const first = evaluate(context);
  assert.ok(first.signals.includes("returned"), `signals=${first.signals}`);
  const used = evaluate({ ...context, returnedUsedToday: true });
  assert.equal(used.signals.includes("returned"), false);
  assert.equal(used.score, first.score - 3);
});

test("真发出去之后才消耗当天那一次，没发不算", () => {
  const dir = tmpDir();
  const gate = new ProactiveGate({
    file: path.join(dir, "proactive-state.json"),
    logFile: path.join(dir, "proactive.log"),
    clock: () => at(20, 0)
  });
  const ctx = {
    now: at(20, 0),
    preset: "clingy",
    idleSeconds: 3,
    lastUserAt: at(13, 0),
    groupsToday: 0
  };
  gate.evaluate(ctx); // 判一次，但没发
  assert.equal(gate.data.returnedDate, null, "只看没发不该消耗");

  gate.data = { ...gate.data, previousIdleSeconds: 1800 };
  const decision = gate.evaluate({ ...ctx, previousIdleSeconds: 1800 });
  assert.ok(decision.signals.includes("returned"));
  gate.commit(at(20, 0), decision);
  assert.equal(gate.data.returnedDate, "2026-10-30");

  // 再离开再回来，同一天不再加这 3 分
  gate.data = { ...gate.data, previousIdleSeconds: 1800 };
  const again = gate.evaluate({ ...ctx, now: at(21, 0), previousIdleSeconds: 1800 });
  assert.equal(again.signals.includes("returned"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("跨天重置：昨天用过不影响今天", () => {
  const dir = tmpDir();
  const gate = new ProactiveGate({
    file: path.join(dir, "proactive-state.json"),
    logFile: path.join(dir, "proactive.log"),
    clock: () => at(20, 0)
  });
  gate.data = { ...gate.data, date: "2026-10-29", groups: 2, returnedDate: "2026-10-29", previousIdleSeconds: 1800 };
  gate.save();
  const decision = gate.evaluate({
    now: at(20, 0),
    preset: "clingy",
    idleSeconds: 3,
    lastUserAt: at(13, 0)
  });
  assert.equal(gate.data.returnedDate, null);
  assert.ok(decision.signals.includes("returned"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 「再试一次」：标准档补发 2 次 ──────────────────────────
test("标准档 = 首轮 + 补发 + 再试一次（两处参数一致）", () => {
  assert.equal(gateModule.PRESETS.standard.followups, 2);
  assert.equal(schedule.PRESETS.standard.followups, 2, "emotion-schedule 必须跟着 gate 走");
  assert.equal(schedule.followupLimit("standard"), 2);
  assert.equal(schedule.followupLimit("quiet"), 0);
  assert.equal(schedule.followupLimit("clingy"), 2);
  assert.equal(schedule.followupLimit(undefined), 2, "未知档位退回标准");
});

// ── 深夜不发第二条 ─────────────────────────────────────────
test("深夜到点时不再补发：不调模型、不发消息", async () => {
  const { EmotionScheduler } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
  const dir = tmpDir();
  const gate = new ProactiveGate({
    file: path.join(dir, "proactive-state.json"),
    logFile: path.join(dir, "proactive.log")
  });
  const clockRef = { now: at(23, 45), idle: 5 };
  const sent = [];
  let assessed = 0;

  const emotion = {
    testMode: true,
    data: {
      waiting: { sentGroups: 1, followupLimit: 2, nextAt: new Date(0).toISOString(), inFlight: false },
      latestReply: null,
      latestUser: { threadId: THREAD, at: new Date(at(23, 0)).toISOString() },
      lastProactiveAt: new Date(at(23, 10)).toISOString(),
      contactPlan: null
    },
    ensureContactPlan: () => true,
    due: () => true,
    contactReviewDue: () => true, // 补发时机到了
    persist: () => true,
    sleepingAt: () => false,
    deepNightAt: () => true, // 已进入睡前 90 分钟
    presetName: () => "standard",
    sleepStartAt: () => 60,
    canContact: () => true,
    assess: async () => {
      assessed += 1;
      return { proactive: { send: true, topic: "还没睡？" } };
    },
    view: () => ({}),
    threads: { pressure: () => 0, visit: () => {} }
  };
  const service = {
    state: { busy: false, loading: false, retry: false, threadId: THREAD, messages: [] },
    gateway: { configured: true },
    proactive: async (topic) => sent.push(topic)
  };
  const sched = new EmotionScheduler({
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

  clockRef.now += 3e5;
  await sched.tick();
  assert.equal(assessed, 0, "深夜不该再花一次模型调用");
  assert.deepEqual(sent, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("同一时刻若不是深夜，补发照常走", async () => {
  const { EmotionScheduler } = require(path.join(__dirname, "..", "src", "emotion-runtime.cjs"));
  const dir = tmpDir();
  const gate = new ProactiveGate({
    file: path.join(dir, "proactive-state.json"),
    logFile: path.join(dir, "proactive.log")
  });
  const clockRef = { now: at(15, 0), idle: 5 };
  const sent = [];
  let assessed = 0;
  const emotion = {
    testMode: true,
    data: {
      waiting: { sentGroups: 1, followupLimit: 2, nextAt: new Date(0).toISOString(), inFlight: false },
      latestReply: null,
      latestUser: { threadId: THREAD, at: new Date(at(14, 0)).toISOString() },
      lastProactiveAt: new Date(at(14, 30)).toISOString(),
      contactPlan: null
    },
    ensureContactPlan: () => true,
    due: () => true,
    contactReviewDue: () => true,
    persist: () => true,
    sleepingAt: () => false,
    deepNightAt: () => false,
    presetName: () => "standard",
    sleepStartAt: () => 60,
    canContact: () => true,
    assess: async () => {
      assessed += 1;
      return { proactive: { send: true, topic: "忙完了吗" } };
    },
    view: () => ({}),
    threads: { pressure: () => 0, visit: () => {} }
  };
  const service = {
    state: { busy: false, loading: false, retry: false, threadId: THREAD, messages: [] },
    gateway: { configured: true },
    proactive: async (topic) => sent.push(topic)
  };
  const sched = new EmotionScheduler({
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
  clockRef.now += 3e5;
  await sched.tick();
  assert.equal(assessed, 1);
  assert.deepEqual(sent, ["忙完了吗"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
