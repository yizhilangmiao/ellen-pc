"use strict";
// 作息学习测试。
// 学不准就两头出错：把活跃时段当睡觉（用户白天被静默），
// 或把睡觉时段当活跃（凌晨被吵醒）。所以环形区间和冷启动都要钉住。
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const P = require(path.join(__dirname, "..", "src", "activity-profile.cjs"));

const NOW = Date.parse("2026-10-30T20:00:00+08:00");

test("时钟解析：合法/非法都要明确", () => {
  assert.equal(P.parseClock("01:00"), 60);
  assert.equal(P.parseClock("09:30"), 570);
  assert.equal(P.parseClock("23:59"), 1439);
  assert.equal(P.parseClock("24:00"), null);
  assert.equal(P.parseClock("9:5"), null);
  assert.equal(P.parseClock(""), null);
  assert.equal(P.parseClock(null), null);
  assert.equal(P.formatClock(60), "01:00");
  assert.equal(P.formatClock(1439), "23:59");
});

test("跨夜区间判断", () => {
  const win = { start: 60, end: 540 }; // 01:00-09:00
  assert.equal(P.inWindow(120, win), true); // 02:00
  assert.equal(P.inWindow(60, win), true); // 01:00 含头
  assert.equal(P.inWindow(539, win), true); // 08:59
  assert.equal(P.inWindow(540, win), false); // 09:00 不含尾
  assert.equal(P.inWindow(0, win), false); // 00:00
  assert.equal(P.inWindow(23 * 60, win), false); // 23:00
  // 反过来跨夜的窗口
  const night = { start: 22 * 60, end: 6 * 60 };
  assert.equal(P.inWindow(23 * 60, night), true);
  assert.equal(P.inWindow(5 * 60, night), true);
  assert.equal(P.inWindow(12 * 60, night), false);
});

test("冷启动曲线推出 01:00-09:00，而不是 23:00-09:00", () => {
  // 23 点和 0 点必须高于睡眠阈值，否则睡前那一段会被静默掉，
  // 「深夜先问一句再劝睡」永远触发不到。
  const sleep = P.detectSleep(P.COLD_START);
  assert.deepEqual(sleep, { start: 60, end: 540 });
});

test("习惯性 1-9 点不在线，能推出来", () => {
  const curve = new Array(24).fill(1);
  for (let h = 1; h < 9; h += 1) curve[h] = 0.05;
  assert.deepEqual(P.detectSleep(curve), { start: 60, end: 540 });
});

test("不到 4 小时的安静段不算睡觉", () => {
  const curve = new Array(24).fill(1);
  for (let h = 2; h < 6; h += 1) curve[h] = 0.05; // 只有 4 小时：2,3,4,5
  assert.deepEqual(P.detectSleep(curve), { start: 120, end: 360 });
  const short = new Array(24).fill(1);
  for (let h = 2; h < 5; h += 1) short[h] = 0.05; // 3 小时
  assert.equal(P.detectSleep(short), null);
});

test("全天都在线时推不出睡觉时间（null），交给默认值", () => {
  assert.equal(P.detectSleep(new Array(24).fill(0.9)), null);
});

test("样本不足走冷启动，并标记 cold", () => {
  const rows = [
    { createdAt: new Date(NOW - 36e5).toISOString() },
    { createdAt: new Date(NOW - 2 * 36e5).toISOString() }
  ];
  const built = P.buildCurve(rows, NOW);
  assert.equal(built.cold, true);
  assert.deepEqual(built.curve, P.COLD_START);
  assert.equal(built.samples, 2);
});

test("样本够时按最近 3 天加权，近的压过远的", () => {
  const rows = [];
  // 昨天 10 点 1 条（×3），5 天前 10 点 1 条（×1）
  rows.push({ at: new Date(NOW - 1 * 864e5).toISOString() });
  rows.push({ at: new Date(NOW - 5 * 864e5).toISOString() });
  // 补到 30 条，都塞在 15 点（旧数据）
  for (let i = 0; i < 28; i += 1) rows.push({ at: new Date(NOW - (6 * 864e5) - i * 6e4).toISOString() });
  const built = P.buildCurve(rows, NOW);
  assert.equal(built.cold, false);
  const max = Math.max(...built.curve);
  assert.equal(max, 1);
  const hour10 = built.curve[new Date(NOW - 864e5).getHours()];
  assert.ok(hour10 > 0);
});

test("超出 7 天的记录不参与", () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push({ at: new Date(NOW - 10 * 864e5 - i * 6e4).toISOString() });
  assert.equal(P.buildCurve(rows, NOW).cold, true);
});

test("手改的睡觉时段优先于推断值", () => {
  const profile = P.createActivityProfile({ file: null, clock: () => NOW });
  assert.deepEqual(profile.sleepWindowText(), { start: "01:00", end: "09:00" });
  assert.deepEqual(profile.sleepWindowText({ start: "23:30", end: "08:00" }), { start: "23:30", end: "08:00" });
  // 非法手改被忽略，退回推断值
  assert.deepEqual(profile.sleepWindowText({ start: "25:00", end: "08:00" }), { start: "01:00", end: "09:00" });
});

test("isSleeping 按分钟判断，边界准确", () => {
  const profile = P.createActivityProfile({ file: null });
  const at = (h, m) => Date.parse(`2026-10-30T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`);
  assert.equal(profile.isSleeping(at(1, 0)), true);
  assert.equal(profile.isSleeping(at(0, 59)), false);
  assert.equal(profile.isSleeping(at(8, 59)), true);
  assert.equal(profile.isSleeping(at(9, 0)), false);
});

test("重算有 6 小时节流：没到点不重复写盘", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
  const file = path.join(dir, "activity-profile.json");
  let clock = NOW;
  const profile = P.createActivityProfile({ file, clock: () => clock });
  profile.refresh([], NOW);
  const first = profile.data.computedAt;
  profile.maybeRefresh([], NOW + 36e5); // 1 小时后：不重算
  assert.equal(profile.data.computedAt, first);
  profile.maybeRefresh([], NOW + 7 * 36e5); // 7 小时后：重算
  assert.notEqual(profile.data.computedAt, first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("曲线文件损坏时退回冷启动，不抛错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-bad-"));
  const file = path.join(dir, "a.json");
  fs.writeFileSync(file, "{\"version\":1,\"curve\":[1,2]}");
  const profile = P.createActivityProfile({ file, clock: () => NOW });
  assert.deepEqual(profile.curve(), P.COLD_START);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 只在下班后开机的人：18-22 点有消息，其余 19 小时全黑。
// 那 19 小时不是睡觉，把整段当睡觉会让用户白天被彻底静默。
test("整天不在电脑前的人：低活跃段裁到合理睡眠长度", () => {
  const rows = [];
  for (let d = 0; d < 5; d += 1) {
    for (const hour of [18, 19, 20, 21, 22]) {
      for (let k = 0; k < 2; k += 1) {
        const ts = new Date(NOW - d * 864e5);
        ts.setHours(hour, k * 20, 0, 0);
        rows.push({ at: ts.toISOString() });
      }
    }
  }
  const { curve, cold } = P.buildCurve(rows, NOW);
  assert.equal(cold, false);
  const sleep = P.detectSleep(curve);
  // 入睡点保留（23:00），向后只取 10 小时，剩下的白天交给「不在电脑前」那条闸
  assert.equal(P.formatClock(sleep.start), "23:00");
  assert.equal(P.formatClock(sleep.end), "09:00");
});

test("正常作息不会被上限裁到", () => {
  const rows = [];
  for (let d = 0; d < 5; d += 1) {
    for (let hour = 6; hour <= 22; hour += 1) {
      const ts = new Date(NOW - d * 864e5);
      ts.setHours(hour, 10, 0, 0);
      rows.push({ at: ts.toISOString() });
    }
  }
  const { curve } = P.buildCurve(rows, NOW);
  const sleep = P.detectSleep(curve);
  assert.equal(P.formatClock(sleep.start), "23:00");
  assert.equal(P.formatClock(sleep.end), "06:00");
});

