"use strict";

// 真包回归：tests/fixtures/ 里放手机实际导出的 .ellenPack，这里逐个验一遍。
// 没放文件时这个测试不算失败，只在输出里提示一句。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const A = require("../src/mobile-archive.cjs");

const DIR = path.join(__dirname, "fixtures");
const MAX_BYTES = 64 * 1024 * 1024;
const FATAL = new Set([
  "CHECKSUM_MISMATCH",
  "INVALID_PACKAGE",
  "INVALID_ARCHIVE_FILES",
  "UNSUPPORTED_VERSION",
  "INVALID_MEDIA_MANIFEST",
]);

function samples() {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => /\.ellenpack$/i.test(f))
    .sort()
    .map((f) => path.join(DIR, f));
}

test("fixtures 里的真实包都能解析成聊天记录", async (t) => {
  const files = samples();
  if (!files.length) {
    t.diagnostic("tests/fixtures 里还没有真包，跳过（把手机「导出聊天资料」得到的 .ellenPack 丢进去即可）");
    return;
  }

  for (const file of files) {
    const name = path.basename(file);
    const size = fs.statSync(file).size;
    if (size > MAX_BYTES) {
      t.diagnostic(`${name}：${(size / 1048576).toFixed(1)}MiB 超过 64MiB，跳过`);
      continue;
    }

    let archive;
    try {
      archive = await A.readArchive(file);
    } catch (e) {
      assert.fail(`${name} 解析失败：${e.code || "ERR"} ${e.message}`);
    }

    const fatal = archive.warnings.filter((w) => FATAL.has(w.code));
    assert.deepStrictEqual(
      fatal.map((w) => w.code),
      [],
      `${name} 出现致命警告：${fatal.map((w) => w.code + " " + w.message).join("；")}`,
    );

    assert.ok(archive.packageContent, `${name} 的清单里没有 package 内容`);
    const snapshot = archive.packageContent.snapshot;
    assert.ok(snapshot && Array.isArray(snapshot.records), `${name} 的快照结构不对`);

    const payload = A.toChatExport(snapshot, { character: "艾莲" });
    assert.strictEqual(payload.format, "ellen-chat-export", `${name} 转出的格式不是聊天记录格式`);
    assert.ok(Array.isArray(payload.conversations), `${name} 没转出会话数组`);

    const msgs = payload.conversations.reduce((n, c) => n + c.messages.length, 0);
    t.diagnostic(`${name}：v${archive.version} · ${payload.conversations.length} 段聊天 / ${msgs} 条消息`);

    // 有聊天就必须有正文，别把空壳当成功
    for (const c of payload.conversations) {
      assert.ok(typeof c.title === "string" && c.title.length > 0, `${name}：有会话没有标题`);
      for (const m of c.messages) {
        assert.ok(m.role === "user" || m.role === "assistant", `${name}：出现未知角色 ${m.role}`);
        assert.ok(typeof m.text === "string", `${name}：消息正文不是字符串`);
      }
    }
  }
});

test("fixtures 里没有放不下的怪文件", (t) => {
  if (!fs.existsSync(DIR)) return;
  const others = fs
    .readdirSync(DIR)
    .filter((f) => !/\.ellenpack$/i.test(f) && f.toLowerCase() !== "readme.md");
  for (const f of others) t.diagnostic(`注意：${f} 不是 .ellenPack，会被忽略`);
});
