"use strict";
// 角色卡解析冒烟测试：这是"导入角色卡"的唯一入口，导入坏了整个产品就废了
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const CC = require(path.join(__dirname, "..", "src", "character-card-format.cjs"));

const V2 = JSON.stringify({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "测试角色",
    description: "一个用于测试的角色。",
    personality: "冷静",
    scenario: "测试场景",
    first_mes: "你好。",
    mes_example: "",
  },
});

test("导出常量存在且大小合理", () => {
  assert.ok(CC.MAX_TEXT > 0, "MAX_TEXT 应有值");
  assert.ok(CC.MAX_FILE >= CC.MAX_TEXT, "文件上限不应小于正文上限");
});

test("crc32 是标准 CRC-32（契约：必须传 Buffer）", () => {
  // 这个函数用于 PNG chunk 与 CHARX 内 card.json 的完整性校验，必须是标准算法。
  // 隐含契约：输入必须是 Buffer / Uint8Array。
  // 传字符串不算错类型那么无害 —— for..of 逐字符 t^='a' 会 NaN→0，结果静默错误。
  const B = (s) => Buffer.from(s, "utf8");
  assert.strictEqual(CC.crc32(B("")), 0);
  assert.strictEqual(CC.crc32(B("abc")), 891568578, "标准 CRC-32(\"abc\") = 0x352441C2");
  assert.strictEqual(CC.crc32(B("123456789")), 3421780262, "标准 CRC-32 check 值 = 0xCBF43926");
  assert.notStrictEqual(CC.crc32(B("abc")), CC.crc32(B("abd")), "不同内容应不同");
});

test("空内容被拒绝", () => {
  assert.throws(() => CC.parseCard(""), /角色卡正文为空|为空/);
  assert.throws(() => CC.parseCard("   "), /为空/);
  assert.throws(() => CC.parseCard(null), /为空/);
});

test("非 JSON 且不允许纯文本时被拒绝", () => {
  assert.throws(() => CC.parseCard("这是一段纯文本角色设定"), /JSON|角色卡/);
});

test("允许纯文本时降级为 text 格式", () => {
  const r = CC.parseCard("这是一段纯文本角色设定", { allowPlain: true });
  assert.strictEqual(r.format, "text");
  assert.ok(r.text.includes("纯文本"));
  assert.strictEqual(r.core, "这是一段纯文本角色设定");
});

test("JSON 数组被拒绝（要求单张卡）", () => {
  assert.throws(() => CC.parseCard("[]"), /对象|列表/);
  assert.throws(() => CC.parseCard("[1,2,3]"), /对象|列表/);
});

test("标准 V2 卡解析成功", () => {
  const r = CC.parseCard(V2);
  assert.strictEqual(r.format, "v2");
  assert.strictEqual(r.name, "测试角色");
  assert.ok(Array.isArray(r.warnings));
});

test("spec 与 spec_version 必须匹配", () => {
  const badVersion = JSON.stringify({ spec: "chara_card_v2", spec_version: "3.0", data: { name: "x" } });
  assert.throws(() => CC.parseCard(badVersion), /spec_version|版本/);
});

test("未知 spec 被拒绝并提示支持范围", () => {
  const unknown = JSON.stringify({ spec: "chara_card_v9", spec_version: "9.0", data: { name: "x" } });
  assert.throws(() => CC.parseCard(unknown), /spec|规范/);
});

test("BOM 不影响解析", () => {
  const r = CC.parseCard("\uFEFF" + V2);
  assert.strictEqual(r.format, "v2");
  assert.strictEqual(r.name, "测试角色");
});

test("含 NUL 字符被拒绝", () => {
  assert.throws(() => CC.parseCard("\u0000abc"), /空字符|UTF-8/);
});
