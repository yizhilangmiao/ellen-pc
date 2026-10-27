"use strict";
// 聊天库冒烟测试：建库 schema + 会话写入 + 删除
// 用 node:sqlite（Node 24 内置），不需要装驱动
//
// 注意：chat-store.cjs 的导出形状是 { ChatStore }，不是类本身。
// 它没有 list() 之类的方法，查询一律直接用 DatabaseSync 读表 —— 这样测的才是真 schema。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const { ChatStore } = require(path.join(__dirname, "..", "src", "chat-store.cjs"));

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ellen-test-"));
  return { dir, file: path.join(dir, "conversations.sqlite") };
}

function query(file, sql, ...params) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function withStore(fn) {
  const { dir, file } = tmpDb();
  const store = new ChatStore(file);
  try {
    fn(store, file);
  } finally {
    try { store.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("建库：文件落地且核心表齐备", () => {
  withStore((store, file) => {
    const tables = query(file, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    for (const t of ["conversations", "messages"]) {
      assert.ok(tables.includes(t), `缺少表 ${t}`);
    }
    // 消息附属表：语音、贴纸、附件、用量
    for (const t of ["message_usage", "message_stickers", "message_attachments"]) {
      assert.ok(tables.includes(t), `缺少附属表 ${t}`);
    }
  });
});

test("会话可创建，落库可查", () => {
  withStore((store, file) => {
    const id = store.create("冒烟测试会话");
    assert.ok(typeof id === "string" && id.length > 0, "create 应返回会话 id");

    const rows = query(file, "SELECT id,title FROM conversations WHERE id=?", id);
    assert.strictEqual(rows.length, 1, "新建的会话应落库");
    assert.strictEqual(rows[0].title, "冒烟测试会话");
  });
});

test("空标题会落到默认标题，不会写空串", () => {
  withStore((store, file) => {
    const id = store.create("");
    const rows = query(file, "SELECT title FROM conversations WHERE id=?", id);
    assert.strictEqual(rows.length, 1);
    assert.ok(String(rows[0].title || "").trim().length > 0, "标题应有兜底值");
  });
});

test("会话标题长度上限 80 字", () => {
  withStore((store) => {
    const ok = store.create("字".repeat(80));
    assert.ok(ok, "80 字应允许");
    assert.throws(() => store.create("字".repeat(81)), "81 字应被拒绝");
  });
});

test("删除会话后行消失", () => {
  withStore((store, file) => {
    const id = store.create("待删除会话");
    store.deleteConversation(id);
    const rows = query(file, "SELECT id FROM conversations WHERE id=?", id);
    assert.strictEqual(rows.length, 0, "删除后不应残留会话行");
  });
});

test("自动清理只接受保留 10 个聊天", () => {
  withStore((store) => {
    assert.throws(() => store.trimHistory(5), /10/);
    assert.doesNotThrow(() => store.trimHistory(10));
  });
});

test("messages 表可写入并读回（role/text 落库不变）", () => {
  withStore((store, file) => {
    const id = store.create("消息落库测试");
    const db = new DatabaseSync(file);
    const now = new Date().toISOString();
    try {
      db.prepare("INSERT INTO messages(id,conversation_id,role,text,status,created_at) VALUES (?,?,?,?,?,?)").run(
        "m1",
        id,
        "user",
        "你好，艾莲",
        "spoken",
        now
      );
    } finally {
      db.close();
    }
    const rows = query(file, "SELECT role,text,status FROM messages WHERE id=?", "m1");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].role, "user");
    assert.strictEqual(rows[0].text, "你好，艾莲");
    assert.strictEqual(rows[0].status, "spoken");
  });
});
