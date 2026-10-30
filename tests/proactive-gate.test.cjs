"use strict";
// 主动消息第一道闸（本地预筛）测试。
// 这道闸唯一的职责是「不发就别花钱」：任何一条硬闸漏了，都会变成
// 每天几十次空跑模型调用；任何一条松了，就会在用户睡着的时候自言自语。
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const GATE = require(path.join(__dirname, "..", "src", "proactive-gate.cjs"));

const NOW = Date.parse("2026-10-30T20:00:00+08:00");
const ago = (ms) => new Date(NOW - ms).toISOString();

function ctx(over = {}) {
  return Object.assign(
    {
      now: NOW,
      preset: "standard",
      idleSeconds: 30,
      lastUserAt: ago(9 * 36e5)
    },
    over
  );
}

test("人在、隔了 9 小时，标准档应当放行", () => {
  const d = GATE.evaluate(ctx());
  assert.equal(d.allow, true);
  assert.equal(d.reason, "scored");
  assert.equal(d.score, 4);
  assert.deepEqual(d.signals, ["gap-8h"]);
});

test("睡觉时段一律不发，且不给分", () => {
  const d = GATE.evaluate(ctx({ sleeping: true }));
  assert.equal(d.allow, false);
  assert.equal(d.reason, "sleeping");
  assert.equal(d.score, 0);
});

test("离开超过 15 分钟不发：不对着空椅子说话", () => {
  assert.equal(GATE.evaluate(ctx({ idleSeconds: 900 })).reason, "away");
  assert.equal(GATE.evaluate(ctx({ idleSeconds: 5000 })).reason, "away");
  // 899 秒还在座
  assert.equal(GATE.evaluate(ctx({ idleSeconds: 899 })).reason, "scored");
});

test("日上限按组算：标准档 4 组满了就不发", () => {
  // 已发 3 组会扣 2 分，所以要足够由头才发得出第 4 组
  const fourth = ctx({
    groupsToday: 3,
    lastUserAt: ago(13 * 36e5),
    previousIdleSeconds: 1200,
    idleSeconds: 20
  });
  assert.equal(GATE.evaluate(fourth).allow, true);
  // 光是隔了 9 小时不够了
  assert.equal(GATE.evaluate(ctx({ groupsToday: 3 })).allow, false);
  assert.equal(GATE.evaluate(ctx({ groupsToday: 4 })).reason, "daily-limit");
});

test("最小间隔没到不发", () => {
  const d = GATE.evaluate(ctx({ lastProactiveAt: ago(36e5), lastUserAt: ago(20 * 36e5) }));
  assert.equal(d.reason, "min-gap");
  assert.equal(d.allow, false);
});

test("刚聊完 30 分钟内不插嘴", () => {
  assert.equal(GATE.evaluate(ctx({ lastUserAt: ago(6e4) })).reason, "just-talked");
  assert.equal(GATE.evaluate(ctx({ lastUserAt: ago(31 * 6e4) })).allow, false); // 只有 3 分，不够
});

test("从离开回到在座 +3，能把 4 小时的缺口补到及格", () => {
  const d = GATE.evaluate(ctx({ lastUserAt: ago(5 * 36e5), previousIdleSeconds: 1200, idleSeconds: 20 }));
  assert.equal(d.allow, true);
  assert.equal(d.score, 6);
  assert.deepEqual(d.signals, ["gap-4h", "returned"]);
});

test("没真的离开过，不算「刚回来」", () => {
  const d = GATE.evaluate(ctx({ lastUserAt: ago(5 * 36e5), previousIdleSeconds: 60, idleSeconds: 20 }));
  assert.equal(d.allow, false);
  assert.equal(d.score, 3);
});

test("连着两组没人回就安静下来", () => {
  const d = GATE.evaluate(ctx({ unanswered: true, groupsToday: 2 }));
  assert.equal(d.allow, false);
  assert.ok(d.signals.includes("unanswered"));
  assert.ok(d.signals.includes("groups-2"));
});

test("三档阈值：同一情境下安静不发、标准不发、黏人发", () => {
  const base = ctx({ lastUserAt: ago(5 * 36e5) }); // 3 分
  assert.equal(GATE.evaluate({ ...base, preset: "quiet" }).allow, false);
  assert.equal(GATE.evaluate({ ...base, preset: "standard" }).allow, false);
  assert.equal(GATE.evaluate({ ...base, preset: "clingy" }).allow, true);
});

test("未知档位退回标准，不报错", () => {
  const d = GATE.evaluate(ctx({ preset: "whatever" }));
  assert.equal(d.preset, "standard");
  assert.equal(d.allow, true);
});

test("没有用户发言记录时不崩，只是分数低", () => {
  const d = GATE.evaluate(ctx({ lastUserAt: null }));
  assert.equal(d.allow, false);
  assert.equal(d.score, 0);
});

test("跨天清零：状态文件按本地日期归零", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const file = path.join(dir, "gate.json");
  let clock = NOW;
  const gate = GATE.createProactiveGate({ file, clock: () => clock, logFile: null });
  gate.commit();
  gate.commit();
  assert.equal(gate.groupsToday(NOW), 2);
  clock = NOW + 24 * 36e5;
  assert.equal(gate.groupsToday(clock), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("决策日志落盘：一行一个判定，能看出为什么没发", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-log-"));
  const logFile = path.join(dir, "logs", "proactive.log");
  const gate = GATE.createProactiveGate({ file: path.join(dir, "g.json"), clock: () => NOW, logFile });
  gate.evaluate(ctx({ sleeping: true }));
  gate.evaluate(ctx());
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /SKIP score=0 preset=standard sleeping/);
  assert.match(lines[1], /ALLOW score=4 preset=standard scored/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("状态文件写坏不影响判定", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-bad-"));
  const file = path.join(dir, "g.json");
  fs.writeFileSync(file, "{ not json");
  const gate = GATE.createProactiveGate({ file, clock: () => NOW });
  assert.equal(gate.groupsToday(NOW), 0);
  assert.equal(gate.evaluate(ctx()).allow, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("previousIdleSeconds 会被记住，用于下一次判断「刚回来」", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-idle-"));
  const file = path.join(dir, "g.json");
  const gate = GATE.createProactiveGate({ file, clock: () => NOW });
  gate.evaluate(ctx({ idleSeconds: 1200, lastUserAt: ago(20 * 36e5) }));
  assert.equal(gate.load().previousIdleSeconds, 1200);
  const d = gate.evaluate(ctx({ idleSeconds: 20, lastUserAt: ago(5 * 36e5) }));
  assert.ok(d.signals.includes("returned"));
  fs.rmSync(dir, { recursive: true, force: true });
});
