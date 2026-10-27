"use strict";
// 授权格式冒烟测试：只测不依赖私钥的部分（机器码、字段校验）
// 运行：pwsh -File ..\..\..\.agents\test.ps1   或   node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const FMT = require(path.join(__dirname, "..", "src", "licensing", "format.cjs"));

const MACHINE_RE = /^EL1(?:-[A-F0-9]{8}){5}-[A-F0-9]{4}$/;

function claims(over) {
  return Object.assign(
    {
      v: 1,
      product: "ellen-companion",
      edition: "desktop-v1",
      keyId: "0123456789abcdef01234567",
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      machine: FMT.machineCode("TEST-MATERIAL"),
      kind: "perpetual",
      issuedAt: 1761561600000,
      expiresAt: null,
    },
    over || {}
  );
}

test("常量与产品标识正确", () => {
  assert.strictEqual(FMT.PRODUCT, "ellen-companion");
  assert.strictEqual(FMT.EDITION, "desktop-v1");
  assert.strictEqual(FMT.PREFIX, "ELLEN1");
});

test("machineCode 生成 EL1- 格式且校验位自洽", () => {
  const code = FMT.machineCode("SOME-MATERIAL");
  assert.match(code, MACHINE_RE);
  // normalizeMachine 会重算校验位，能过说明码自洽
  assert.strictEqual(FMT.normalizeMachine(code), code);
});

test("同一个 material 稳定、不同 material 不同", () => {
  assert.strictEqual(FMT.machineCode("A"), FMT.machineCode("A"));
  assert.notStrictEqual(FMT.machineCode("A"), FMT.machineCode("B"));
});

test("normalizeMachine 拒绝格式错误", () => {
  assert.throws(() => FMT.normalizeMachine("EL1-XXXX"), (e) => {
    assert.strictEqual(e.code, "MACHINE_FORMAT");
    return true;
  });
  assert.throws(() => FMT.normalizeMachine(null), (e) => e.code === "MACHINE_FORMAT");
});

test("normalizeMachine 拒绝被篡改的校验位", () => {
  const code = FMT.machineCode("TAMPER-ME");
  const bad = code.slice(0, -4) + (code.slice(-4) === "0000" ? "1111" : "0000");
  assert.throws(() => FMT.normalizeMachine(bad), (e) => e.code === "MACHINE_FORMAT");
});

test("validateClaims 接受合法永久授权并冻结", () => {
  const out = FMT.validateClaims(claims());
  assert.ok(Object.isFrozen(out));
  assert.strictEqual(out.kind, "perpetual");
});

test("validateClaims 拒绝字段缺失或多出", () => {
  const missing = claims();
  delete missing.expiresAt;
  assert.throws(() => FMT.validateClaims(missing), (e) => e.code === "FORMAT");

  const extra = Object.assign(claims(), { bonus: 1 });
  assert.throws(() => FMT.validateClaims(extra), (e) => e.code === "FORMAT");
});

test("validateClaims 拒绝跨产品/跨版本授权", () => {
  assert.throws(() => FMT.validateClaims(claims({ edition: "android-v1" })), (e) => e.code === "PRODUCT");
  assert.throws(() => FMT.validateClaims(claims({ product: "other" })), (e) => e.code === "PRODUCT");
  assert.throws(() => FMT.validateClaims(claims({ v: 2 })), (e) => e.code === "PRODUCT");
});

test("validateClaims 拒绝非法 keyId / id / issuedAt", () => {
  assert.throws(() => FMT.validateClaims(claims({ keyId: "short" })), (e) => e.code === "FORMAT");
  assert.throws(() => FMT.validateClaims(claims({ id: "not-a-uuid" })), (e) => e.code === "FORMAT");
  assert.throws(() => FMT.validateClaims(claims({ issuedAt: -1 })), (e) => e.code === "FORMAT");
  assert.throws(() => FMT.validateClaims(claims({ issuedAt: 1.5 })), (e) => e.code === "FORMAT");
});

test("kind 与 expiresAt 的组合必须合法", () => {
  // perpetual 不许带到期时间
  assert.throws(() => FMT.validateClaims(claims({ expiresAt: 1761561600000 + 1000 })), (e) => e.code === "FORMAT");
  // trial 必须带且晚于签发时间
  assert.throws(() => FMT.validateClaims(claims({ kind: "trial", expiresAt: null })), (e) => e.code === "FORMAT");
  assert.throws(() => FMT.validateClaims(claims({ kind: "trial", expiresAt: 1761561600000 })), (e) => e.code === "FORMAT");
  const ok = FMT.validateClaims(claims({ kind: "trial", expiresAt: 1761561600000 + 86400000 }));
  assert.strictEqual(ok.kind, "trial");
});

test("未知 kind 被拒绝", () => {
  assert.throws(() => FMT.validateClaims(claims({ kind: "lifetime" })), (e) => e.code === "FORMAT");
});
