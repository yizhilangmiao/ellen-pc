"use strict";
// 外观存储测试：白名单从业内三张改成「按角色包声明」，这里守住两件事——
// 1 老用户存的 classic/smile/sleepy 必须照旧读得出来；
// 2 放开白名单不等于放开脏数据，穿越和野生 id 依旧要挡在门外。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AppearanceStore } = require(path.join(__dirname, "..", "src", "appearance-store.cjs"));

function makeStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ellen-appearance-"));
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new AppearanceStore({ dataDir });
}

const ROLE = "builtin-ellen-lover-trial-v3-20260930-95a1edae";

test("没有设置文件时给默认值", () => {
  const store = makeStore();
  const view = store.view(ROLE);
  assert.strictEqual(view.version, 1);
  assert.strictEqual(view.revision, 0);
  assert.strictEqual(view.avatar, null);
  assert.strictEqual(view.background, null);
  assert.strictEqual(view.fit, "contain");
  assert.strictEqual(view.role, ROLE);
});

test("老用户的三张头像照旧读得出来、存得回去", () => {
  const store = makeStore();
  for (const avatar of ["classic", "smile", "sleepy"]) {
    const before = store.read(ROLE);
    const view = store.update(ROLE, { avatar }, before.revision);
    assert.strictEqual(view.avatar, avatar);
    assert.strictEqual(store.read(ROLE).avatar, avatar);
  }
});

test("角色包新声明的头像 id 也能存", () => {
  const store = makeStore();
  const view = store.update(ROLE, { avatar: "miku-01" }, store.read(ROLE).revision);
  assert.strictEqual(view.avatar, "miku-01");
  assert.strictEqual(store.read(ROLE).avatar, "miku-01");
});

test("脏头像值被拒绝，且不写坏已有设置", () => {
  const store = makeStore();
  store.update(ROLE, { avatar: "classic" }, 0);
  for (const avatar of ["../../etc/passwd", "A/B", "大寫", "", "a".repeat(200), 42]) {
    assert.throws(() => store.update(ROLE, { avatar }, store.read(ROLE).revision), /请选择列表中的头像/);
  }
  assert.strictEqual(store.read(ROLE).avatar, "classic", "被拒的写入不应改到原设置");
});

test("revision 不匹配时不允许改", () => {
  const store = makeStore();
  store.update(ROLE, { avatar: "classic" }, 0);
  assert.throws(() => store.update(ROLE, { avatar: "smile" }, 0), /外观设置已变化/);
});

test("不同角色各存各的，互不影响", () => {
  const store = makeStore();
  const other = "builtin-ellen-any-profile";
  store.update(ROLE, { avatar: "classic" }, 0);
  store.update(other, { avatar: "sleepy" }, 0);
  assert.strictEqual(store.read(ROLE).avatar, "classic");
  assert.strictEqual(store.read(other).avatar, "sleepy");
});

test("背景只收 PNG，且尺寸有上限", () => {
  const store = makeStore();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  assert.throws(() => store.background(ROLE, { bytes: Buffer.from("notpng!!"), width: 10, height: 10 }, 0), /图片无效/);
  assert.throws(() => store.background(ROLE, { bytes: png, width: 0, height: 10 }, 0), /图片无效/);
  assert.throws(() => store.background(ROLE, { bytes: png, width: 5000, height: 10 }, 0), /图片无效/);
});

test("设置文件损坏时报错而不是静默重置", () => {
  const store = makeStore();
  const dir = store.directory(ROLE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), "{ 坏掉的 JSON");
  assert.throws(() => store.read(ROLE), /外观设置暂时无法读取/);
});
