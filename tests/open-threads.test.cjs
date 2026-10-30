"use strict";
// 话题台账测试。
// 这条链断了，她就从"记着你的事"退化成"随机问候"，或者更糟——变成催办。
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const T = require(path.join(__dirname, "..", "src", "open-threads.cjs"));

const NOW = Date.parse("2026-10-30T20:00:00+08:00");
const iso = (ms) => new Date(ms).toISOString();

const mk = () => T.createOpenThreads({ file: null, clock: () => NOW });

const thread = (id, dueMs, extra = {}) => ({
  id,
  topic: `他说要弄 ${id}`,
  quote: `原话 ${id}`,
  kind: "plan",
  dueAt: iso(dueMs),
  ...extra
});

test("合法话题能入库，字段被裁到上限", () => {
  const t = T.sanitizeThread({ id: "t1", topic: "x".repeat(200), quote: "y".repeat(200), kind: "promise", dueAt: iso(NOW) }, NOW);
  assert.equal(t.topic.length, T.MAX_TOPIC);
  assert.equal(t.quote.length, T.MAX_QUOTE);
  assert.equal(t.kind, "promise");
});

test("不合法话题整条丢弃：没 id / 没 topic / 时间解析不了 / 十四天以后", () => {
  assert.equal(T.sanitizeThread({ topic: "开会" }, NOW), null);
  assert.equal(T.sanitizeThread({ id: "t1" }, NOW), null);
  assert.equal(T.sanitizeThread({ id: "t1", topic: "开会", dueAt: "明早" }, NOW), null);
  assert.equal(T.sanitizeThread({ id: "t1", topic: "开会", dueAt: iso(NOW + 20 * 864e5) }, NOW), null);
  assert.notEqual(T.sanitizeThread({ id: "t1", topic: "开会", dueAt: iso(NOW + 3 * 864e5) }, NOW), null);
});

test("kind 不认识时退回 unfinished，不丢整条", () => {
  const t = T.sanitizeThread({ id: "t1", topic: "开会", kind: "奇怪", dueAt: iso(NOW) }, NOW);
  assert.equal(t.kind, "unfinished");
});

test("没到期的不问——不提前问就是在催", () => {
  const tb = mk();
  tb.apply([thread("t1", NOW + 36e5)], [], NOW);
  assert.equal(tb.pick(NOW), null);
  assert.equal(tb.pick(NOW + 2 * 36e5).id, "t1");
});

test("到期了按最早该问的优先", () => {
  const tb = mk();
  tb.apply([thread("late", NOW - 36e5), thread("early", NOW - 5 * 36e5)], [], NOW);
  assert.equal(tb.pick(NOW).id, "early");
});

test("同一件事两次回访至少隔 12 小时", () => {
  const tb = mk();
  tb.apply([thread("t1", NOW - 36e5)], [], NOW);
  assert.equal(tb.pick(NOW).id, "t1");
  tb.visit("t1", NOW);
  assert.equal(tb.pick(NOW), null, "刚问过不许接着问");
  assert.equal(tb.pick(NOW + 11 * 36e5), null, "11 小时还不够");
  assert.equal(tb.pick(NOW + 12 * 36e5).id, "t1", "12 小时之后可以再问一次");
});

test("同一件事最多问两次，第三次必须等用户先提", () => {
  const tb = mk();
  tb.apply([thread("t1", NOW - 36e5)], [], NOW);
  tb.visit("t1", NOW);
  tb.visit("t1", NOW + 13 * 36e5);
  assert.equal(tb.pick(NOW + 30 * 36e5), null, "问了两次就该闭嘴");
  assert.equal(tb.list()[0].status, "open", "事件本身没了结，只是她不再主动提");
});

test("已了结的话题不再问，也不再喂给模型", () => {
  const tb = mk();
  tb.apply([thread("t1", NOW - 36e5)], [], NOW);
  assert.equal(tb.summary(NOW).length, 1);
  const r = tb.apply([], [{ id: "t1", status: "done" }], NOW);
  assert.equal(r.closed, 1);
  assert.equal(tb.pick(NOW), null);
  assert.equal(tb.summary(NOW).length, 0);
});

test("同一件事再次被提到，不重置已问次数（否则能无限追问）", () => {
  const tb = mk();
  tb.apply([thread("t1", NOW - 36e5)], [], NOW);
  tb.visit("t1", NOW);
  tb.visit("t1", NOW + 13 * 36e5);
  tb.apply([thread("t1", NOW - 36e5, { topic: "他说那个会推到下周" })], [], NOW + 40 * 36e5);
  assert.equal(tb.list()[0].visits, 2);
  assert.equal(tb.pick(NOW + 40 * 36e5), null);
  assert.match(tb.list()[0].topic, /推到下周/);
});

test("台账上限 20 条，超了先淘汰已了结的", () => {
  const tb = mk();
  const many = [];
  for (let i = 0; i < 25; i += 1) many.push(thread(`t${i}`, NOW + i * 6e4));
  tb.apply(many, [], NOW);
  assert.equal(tb.list().length, T.MAX_THREADS);
  // 把最早三件标成已了结，再加三条新的：应该优先淘汰那三件已了结的
  tb.apply([], [{ id: "t0", status: "done" }, { id: "t1", status: "done" }, { id: "t2", status: "done" }], NOW);
  tb.apply([thread("n1", NOW + 36e5), thread("n2", NOW + 37e5), thread("n3", NOW + 38e5)], [], NOW);
  const ids = tb.list().map((t) => t.id);
  assert.equal(ids.length, T.MAX_THREADS);
  assert.equal(ids.includes("t0"), false, "已了结的最早一条该被淘汰");
  assert.equal(ids.includes("n3"), true, "新加的要留下");
});

test("本地打分：到期一条 +2，最多 +4", () => {
  const tb = mk();
  assert.equal(tb.pressure(NOW), 0);
  tb.apply([thread("a", NOW - 1e3)], [], NOW);
  assert.equal(tb.pressure(NOW), 2);
  tb.apply([thread("b", NOW - 2e3), thread("c", NOW - 3e3)], [], NOW);
  assert.equal(tb.pressure(NOW), 4, "三条到期也封顶 +4");
  assert.equal(tb.pressure(NOW - 1e4), 0, "还没到期不算压力");
});

test("摘要只喂未了结的，最多六条，按到期先后", () => {
  const tb = mk();
  const many = [];
  for (let i = 0; i < 9; i += 1) many.push(thread(`t${i}`, NOW + (i - 3) * 6e4));
  tb.apply(many, [], NOW);
  const s = tb.summary(NOW);
  assert.equal(s.length, 6);
  assert.equal(s[0].id, "t0", "最早到期的排前面");
  assert.equal(s[0].overdue, true, "t0 已经过点了");
  assert.equal(s[5].overdue, false, "t5 还没到点");
  assert.equal(typeof s[0].asked, "number");
});

test("写盘后能读回来，文件坏了退回空台账不抛", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "threads-"));
  const file = path.join(dir, "open-threads.json");
  const tb = T.createOpenThreads({ file, clock: () => NOW });
  tb.apply([thread("t1", NOW - 36e5)], [], NOW);
  const again = T.createOpenThreads({ file, clock: () => NOW });
  assert.equal(again.list().length, 1);
  assert.equal(again.pick(NOW).id, "t1");

  fs.writeFileSync(file, "{不是 json");
  const broken = T.createOpenThreads({ file, clock: () => NOW });
  assert.deepEqual(broken.list(), []);
  assert.equal(broken.pick(NOW), null);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("threadOps 里不认识的状态和非数组输入都被忽略", () => {
  const tb = mk();
  tb.apply([thread("t1", NOW)], [{ id: "t1", status: "乱写" }], NOW);
  assert.equal(tb.list()[0].status, "open");
  assert.deepEqual(tb.apply([], "不是数组", NOW), { added: 0, closed: 0 });
  assert.equal(tb.list().length, 1);
});
