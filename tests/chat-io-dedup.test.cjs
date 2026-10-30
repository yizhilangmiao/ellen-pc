"use strict";

// 导入去重：同一个包重复导入时，不能每次都在历史列表里多出一段一模一样的聊天。
// 这里用假 store 直接测 applyImport，不碰真实数据库和文件对话框。

const test = require("node:test");
const assert = require("node:assert");
const chatIO = require("../src/chat-io.cjs");

let seq = 0;
function fakeStore() {
  const threads = [];
  const msgs = new Map();
  return {
    list: () => threads.map((t) => ({ ...t })),
    messages: (id) => (msgs.get(id) || []).map((m) => ({ ...m })),
    createConversation(title) {
      const id = `t${++seq}`;
      threads.push({ id, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      msgs.set(id, []);
      return { id };
    },
    put(threadId, message) {
      const arr = msgs.get(threadId);
      if (!arr) throw new Error("no thread " + threadId);
      arr.push({ ...message });
    },
    count: () => threads.length,
    totalMessages: () => [...msgs.values()].reduce((n, a) => n + a.length, 0),
  };
}

const payload = (title, texts) => ({
  format: chatIO.FORMAT,
  version: chatIO.VERSION,
  exportedAt: "2026-10-28T14:00:00.000Z",
  character: null,
  conversations: [
    {
      title,
      createdAt: "2026-10-07T09:00:00.000Z",
      updatedAt: "2026-10-07T09:02:00.000Z",
      messages: texts.map((t, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        text: t,
        createdAt: `2026-10-07T09:0${i}:00.000Z`,
      })),
    },
  ],
});

test("第一次导入正常落库", () => {
  const store = fakeStore();
  const r = chatIO.applyImport(store, payload("雨天", ["外面下雨了", "记得带伞。"]));
  assert.strictEqual(r.conversations, 1);
  assert.strictEqual(r.messages, 2);
  assert.strictEqual(r.repeated, 0);
  assert.strictEqual(store.count(), 1);
  assert.strictEqual(store.totalMessages(), 2);
});

test("同一个包再导一次：不新增会话，并提示已经导过", () => {
  const store = fakeStore();
  const data = payload("雨天", ["外面下雨了", "记得带伞。"]);
  chatIO.applyImport(store, data);
  assert.throws(() => chatIO.applyImport(store, data), /已经导入过/);
  assert.strictEqual(store.count(), 1, "重复导入不应该多出一段聊天");
  assert.strictEqual(store.totalMessages(), 2);
});

test("标题相同但内容不同：当成另一段正常导入", () => {
  const store = fakeStore();
  chatIO.applyImport(store, payload("雨天", ["外面下雨了"]));
  const r = chatIO.applyImport(store, payload("雨天", ["今天出太阳了", "晒被子。"]));
  assert.strictEqual(r.conversations, 1);
  assert.strictEqual(r.repeated, 0);
  assert.strictEqual(store.count(), 2);
});

test("一次导入里既有新聊天也有导过的：新增新的，跳过旧的", () => {
  const store = fakeStore();
  const first = payload("雨天", ["外面下雨了", "记得带伞。"]);
  chatIO.applyImport(store, first);

  const mixed = payload("雨天", ["外面下雨了", "记得带伞。"]);
  mixed.conversations.push({
    title: "晴天",
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:01:00.000Z",
    messages: [{ role: "user", text: "今天天气不错", createdAt: "2026-10-08T10:00:00.000Z" }],
  });

  const r = chatIO.applyImport(store, mixed);
  assert.strictEqual(r.conversations, 1, "只应新增「晴天」这一段");
  assert.strictEqual(r.repeated, 1, "「雨天」应被识别为重复");
  assert.strictEqual(r.messages, 1);
  assert.strictEqual(store.count(), 2);
});

test("指纹只由内容决定：字段顺序变化不影响判重", () => {
  const a = chatIO.conversationFingerprint("雨天", [
    { role: "user", text: "外面下雨了", createdAt: "2026-10-07T09:00:00.000Z" },
  ]);
  const b = chatIO.conversationFingerprint("雨天", [
    { createdAt: "2026-10-07T09:00:00.000Z", text: "外面下雨了", role: "user" },
  ]);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, chatIO.conversationFingerprint("雨天", [{ role: "user", text: "外面下雨了", createdAt: "2026-10-07T09:00:01.000Z" }]));
});
