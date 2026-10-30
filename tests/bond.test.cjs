"use strict";
// 亲密度点数（bond）冒烟测试。
// 只测算法：点数怎么涨、双条件怎么挡、30 天能不能到恋人、信写得对不对。
// 跑在 node:sqlite 上（Node 24 内置），不需要驱动。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { Bond, POLICY } = require(path.join(__dirname, "..", "memory", "src", "bond.cjs"));

function make({ characterId = "ellen", start = "2026-01-01T09:00:00.000Z" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ellen-bond-"));
  const file = path.join(dir, "bond.sqlite");
  const db = new DatabaseSync(file);
  let now = start;
  const bond = new Bond(db, { characterId, clock: () => now });
  bond.initialize();
  return {
    bond,
    db,
    dir,
    at() {
      return now;
    },
    set(t) {
      now = t;
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
test("一条消息 +1，同一天再加一条不重复给天数分", () => {
  const s = make();
  try {
    const a = s.bond.record({ role: "user", occurredAt: "2026-01-01T09:00:00.000Z" });
    assert.strictEqual(a.points, 4, "首条 = 1 条消息 + 3 天");
    const b = s.bond.record({ role: "assistant", occurredAt: "2026-01-01T09:05:00.000Z" });
    assert.strictEqual(b.points, 5, "同日第二条只 +1");
    assert.strictEqual(b.stageMessages, 2, "双方消息都计入本阶段条数");
  } finally {
    s.close();
  }
});

test("换一天再聊，天数分 +3", () => {
  const s = make();
  try {
    s.bond.record({ role: "user", occurredAt: "2026-01-01T09:00:00.000Z" });
    const b = s.bond.record({ role: "user", occurredAt: "2026-01-02T09:00:00.000Z" });
    assert.strictEqual(b.points, 8, "1 号 4 点 + 2 号 4 点");
  } finally {
    s.close();
  }
});

test("不认识的 role 不计数", () => {
  const s = make();
  try {
    const a = s.bond.record({ role: "system", occurredAt: "2026-01-01T09:00:00.000Z" });
    assert.strictEqual(a.points, 0);
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------------------
test("点数够了但只有 29 条，不升阶", () => {
  const s = make();
  try {
    // 30 条 = 1 号 10 条 + 2 号 10 条 + 3 号 10 条 → 3 天共 30 条 = 30 + 9 = 39 点
    let last;
    for (let day = 1; day <= 2; day += 1) {
      for (let i = 0; i < 10; i += 1) {
        last = s.bond.record({
          role: i % 2 ? "assistant" : "user",
          occurredAt: `2026-01-0${day}T10:${String(i).padStart(2, "0")}:00.000Z`,
        });
      }
    }
    // 加第 3 天前 9 条 = 29 条
    for (let i = 0; i < 9; i += 1) {
      last = s.bond.record({
        role: i % 2 ? "assistant" : "user",
        occurredAt: `2026-01-03T10:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }
    assert.strictEqual(last.stageMessages, 29);
    assert.strictEqual(last.points, 38, "29 条 + 3 天 = 38 点，早已超过相识门槛 25");
    assert.strictEqual(last.stage, "acquainted", "点数超了也不许动");
  } finally {
    s.close();
  }
});

test("满 30 条且点数够，升到熟悉并写出一封信", () => {
  const s = make();
  try {
    let last;
    for (let i = 0; i < 30; i += 1) {
      last = s.bond.record({
        role: i % 2 ? "assistant" : "user",
        occurredAt: `2026-01-01T10:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }
    assert.strictEqual(last.stage, "familiar");
    assert.strictEqual(last.stageMessages, 0, "升阶后条数归零，重新攒");
    const letters = s.bond.listLetters();
    assert.strictEqual(letters.length, 2, "相识信 + 熟悉信");
    assert.strictEqual(letters[0].stage, "acquainted");
    assert.strictEqual(letters[1].stage, "familiar");
    assert.strictEqual(letters[1].signature, "——你的好朋友艾莲");
    assert.strictEqual(letters[1].kind, "letter");
    assert.ok(letters[1].title.length > 0 && letters[1].body.length > 0);
  } finally {
    s.close();
  }
});

test("光靠天数不给升阶：聊一句就停，永远停在相识", () => {
  const s = make();
  try {
    // 模拟连聊 40 天、每天只说 1 句：40 条 < 30 条门槛？其实 40 > 30
    // 这里改成 20 天各 1 条：点 20+60=80 过门槛，条数 20 < 30
    let last;
    for (let d = 1; d <= 20; d += 1) {
      last = s.bond.record({ role: "user", occurredAt: `2026-02-${String(d).padStart(2, "0")}T10:00:00.000Z` });
    }
    assert.strictEqual(last.points, 80);
    assert.strictEqual(last.stageMessages, 20);
    assert.strictEqual(last.stage, "acquainted", "80 点够熟悉了，但 20 条不够 30 条，卡住");
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------------------
test("天天聊 10 条，第 30 天成恋人（含 5 封信）", () => {
  const s = make();
  try {
    let day = 0;
    let stage = "acquainted";
    const promotions = [];
    for (let d = 1; d <= 40; d += 1) {
      for (let i = 0; i < 10; i += 1) {
        const r = s.bond.record({
          role: i % 2 ? "assistant" : "user",
          occurredAt: `2026-03-${String(d).padStart(2, "0")}T10:${String(i).padStart(2, "0")}:00.000Z`,
        });
        if (r.promotions?.length) {
          for (const p of r.promotions) promotions.push({ day: d, ...p });
          stage = r.stage;
          day = d;
        }
        if (stage === "lover") break;
      }
      if (stage === "lover") break;
    }
    const byStage = Object.fromEntries(promotions.map((p) => [p.to, p.day]));
    assert.strictEqual(byStage.familiar, 3, "升到熟悉：第 3 天（前 2 天只攒了 20 条）");
    assert.strictEqual(byStage.trusted, 7, "升到信赖：第 7 天");
    assert.strictEqual(byStage.close, 13, "升到亲近：第 13 天");
    assert.strictEqual(byStage.lover, 30, "升到恋人：第 30 天");

    const letters = s.bond.listLetters();
    assert.strictEqual(letters.length, 5, "5 个阶段各一封");
    assert.strictEqual(letters.at(-1).kind, "love");
    assert.strictEqual(letters.at(-1).signature, "——你的恋人——爱你的鲨鱼");
    assert.deepStrictEqual(
      letters.map((l) => l.stage),
      ["acquainted", "familiar", "trusted", "close", "lover"],
      "五封信按阶段顺序排好"
    );
    assert.deepStrictEqual(letters.map((l) => l.signature), [
      "——你的朋友艾莲",
      "——你的好朋友艾莲",
      "——艾莲",
      "——你的、就差一句话的艾莲",
      "——你的恋人——爱你的鲨鱼",
    ]);
  } finally {
    s.close();
  }
});

test("到了恋人就不再升，继续聊只加点数", () => {
  const s = make();
  try {
    s.bond.debugBump(6000);
    assert.strictEqual(s.bond.state().stage, "lover");
    const before = s.bond.state().points;
    const after = s.bond.record({ role: "user", occurredAt: "2026-12-31T10:00:00.000Z" });
    assert.strictEqual(after.stage, "lover");
    assert.ok(after.points > before);
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------------------
test("同一阶段不会重复写信", () => {
  const s = make();
  try {
    s.bond.debugBump(40); // 升到熟悉
    const n1 = s.bond.listLetters().length;
    s.bond.debugBump(30);
    const n2 = s.bond.listLetters().length;
    assert.ok(n1 >= 2);
    assert.strictEqual(n2, n1, "再聊也不会给熟悉补第二封");
  } finally {
    s.close();
  }
});

test("未读先给阶段最低的那一封，读完轮下一个", () => {
  const s = make();
  try {
    s.bond.debugBump(6000); // 全升完，5 封信都未读
    const first = s.bond.nextUnread();
    assert.strictEqual(first.stage, "acquainted", "5 封未读里最低的是相识");
    s.bond.markRead(first.id);
    const second = s.bond.nextUnread();
    assert.strictEqual(second.stage, "familiar");
    assert.strictEqual(s.bond.state().unread, 4);
    // 全读完
    for (const l of s.bond.listLetters()) s.bond.markRead(l.id);
    assert.strictEqual(s.bond.nextUnread(), null, "全读完返回 null，调用方转去信匣");
    assert.strictEqual(s.bond.state().unread, 0);
  } finally {
    s.close();
  }
});

test("state 的 next 信息能直接喂 UI（差多少点、差多少条）", () => {
  const s = make();
  try {
    s.bond.record({ role: "user", occurredAt: "2026-01-01T09:00:00.000Z" });
    const st = s.bond.state();
    assert.strictEqual(st.stage, "acquainted");
    assert.strictEqual(st.label, "相识");
    assert.strictEqual(st.next.stage, "familiar");
    assert.strictEqual(st.next.pointsNeeded, 25);
    assert.strictEqual(st.next.messagesNeeded, 30);
    assert.strictEqual(st.progress, 4 / 25);
  } finally {
    s.close();
  }
});

test("落款五档齐备，没有漏", () => {
  const need = ["acquainted", "familiar", "trusted", "close", "lover"];
  for (const s of need) {
    assert.ok(POLICY.signatures[s], "缺落款: " + s);
    assert.ok(POLICY.labels[s], "缺标签: " + s);
    assert.strictEqual(typeof POLICY.thresholds[s], "number", "缺门槛: " + s);
  }
  assert.strictEqual(POLICY.minStageMessages, 30);
  assert.strictEqual(POLICY.perMessage, 1);
  assert.strictEqual(POLICY.perDay, 3);
});

test("debugReset 能清干净，重来一遍结果一致", () => {
  const s = make();
  try {
    s.bond.debugBump(200);
    const first = s.bond.state();
    assert.ok(first.points > 0);
    s.bond.debugReset();
    assert.strictEqual(s.bond.state().points, 0);
    assert.strictEqual(s.bond.listLetters().length, 0);
    s.bond.debugBump(200);
    assert.strictEqual(s.bond.state().stage, first.stage, "重置后跑同样步数应落在同一阶段");
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------------------
test("升阶后留下一句提示，她说一轮话就清掉", () => {
  const s = make();
  try {
    let last = null;
    for (let i = 1; i <= 30; i += 1) {
      last = s.bond.record({ role: "user", occurredAt: `2026-01-01T09:${String(i).padStart(2, "0")}:00.000Z` });
    }
    assert.strictEqual(last.stage, "familiar", "30 条应当升到熟悉");
    assert.deepStrictEqual(
      last.promotions.map((p) => p.to),
      ["familiar"]
    );
    const notice = s.bond.pendingNotice();
    assert.ok(notice, "升阶后应当有提示");
    assert.strictEqual(notice.stage, "familiar");
    assert.strictEqual(notice.label, POLICY.labels.familiar);
    s.bond.record({ role: "assistant", occurredAt: "2026-01-01T10:00:00.000Z" });
    assert.strictEqual(s.bond.pendingNotice(), null, "说完就清掉，不会每轮重复");
  } finally {
    s.close();
  }
});

test("没升阶就没有提示", () => {
  const s = make();
  try {
    s.bond.record({ role: "user", occurredAt: "2026-01-01T09:00:00.000Z" });
    assert.strictEqual(s.bond.pendingNotice(), null);
  } finally {
    s.close();
  }
});


// ---------------------------------------------------------------------------
test("最后一封没拆封前不出正文，拆封后才给全", () => {
  const s = make({ characterId: "ellen-lock" });
  try {
    s.bond.createLetter({
      from: "close",
      to: "lover",
      since: "2026-01-20T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
    });
    const sealed = s.bond.listLetters().find((l) => l.stage === "lover");
    assert.ok(sealed, "情书应该建出来");
    assert.strictEqual(sealed.locked, true, "恋人那封默认是封着的");
    assert.strictEqual(sealed.body, null, "没拆封不许把正文送出去");

    const opened = s.bond.unlockLetter(sealed.id);
    assert.strictEqual(opened.locked, false, "拆封后不再锁");
    assert.ok(opened.body && opened.body.length > 0, "拆封后要给正文");
    assert.ok(opened.unlocked_at, "要记下拆封时间");
  } finally {
    s.close();
  }
});

test("普通阶段那几封不锁，直接可读", () => {
  const s = make({ characterId: "ellen-open" });
  try {
    s.bond.createLetter({
      from: null,
      to: "acquainted",
      since: "",
      until: "2026-01-05T00:00:00.000Z",
    });
    const first = s.bond.listLetters().find((l) => l.stage === "acquainted");
    assert.ok(first, "第一封应该建出来");
    assert.strictEqual(first.locked, false, "相识那封不锁");
    assert.ok(first.body && first.body.length > 0, "不锁的直接给正文");
  } finally {
    s.close();
  }
});

// ---------------------------------------------------------------------------
// 历史追认：装应用之前就存在的聊天，一次性补算点数，只跑一次
test("backfill：3 条同一天 = 3 条 + 1 天 = 6 分，并标记已追认", () => {
  const s = make();
  try {
    const out = s.bond.backfill([
      { role: "user", occurredAt: "2026-01-01T09:00:00.000Z" },
      { role: "assistant", occurredAt: "2026-01-01T09:01:00.000Z" },
      { role: "user", occurredAt: "2026-01-01T09:02:00.000Z" },
    ]);
    assert.strictEqual(out.replayed, 3);
    assert.strictEqual(out.state.points, 6, "3 条 + 1 天 = 6");
    assert.strictEqual(s.bond.needsBackfill(), false, "追认完不该再需要重跑");
  } finally {
    s.close();
  }
});

test("backfill：跨两天，第二天多拿一天分", () => {
  const s = make();
  try {
    const out = s.bond.backfill([
      { role: "user", occurredAt: "2026-01-01T09:00:00.000Z" },
      { role: "assistant", occurredAt: "2026-01-02T09:00:00.000Z" },
    ]);
    assert.strictEqual(out.state.points, 8, "2 条 + 2 天 = 8");
  } finally {
    s.close();
  }
});

test("backfill：只跑一次，第二次跳过", () => {
  const s = make();
  try {
    s.bond.backfill([{ role: "user", occurredAt: "2026-01-01T09:00:00.000Z" }]);
    const second = s.bond.backfill([{ role: "user", occurredAt: "2026-01-01T10:00:00.000Z" }]);
    assert.strictEqual(second.replayed, 0);
    assert.strictEqual(second.skipped, true);
    assert.strictEqual(second.state.points, 4, "点数不变");
  } finally {
    s.close();
  }
});

test("backfill：空历史不标记已追认，以后还能补", () => {
  const s = make();
  try {
    const out = s.bond.backfill([]);
    assert.strictEqual(out.replayed, 0);
    assert.strictEqual(out.skipped, false);
    assert.strictEqual(s.bond.needsBackfill(), true, "没数据时不该把开关关掉");
  } finally {
    s.close();
  }
});

test("backfill：乱序输入按时间排，非 user/assistant 的角色被丢掉", () => {
  const s = make();
  try {
    const out = s.bond.backfill([
      { role: "user", occurredAt: "2026-01-02T09:00:00.000Z" },
      { role: "system", occurredAt: "2026-01-02T10:00:00.000Z" },
      { role: "assistant", occurredAt: "2026-01-01T09:00:00.000Z" },
      { role: "user", occurredAt: null },
    ]);
    assert.strictEqual(out.replayed, 2, "system 与空时间被过滤");
    assert.strictEqual(out.state.points, 8, "2 条 + 2 天 = 8");
  } finally {
    s.close();
  }
});
