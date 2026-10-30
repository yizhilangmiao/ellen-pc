"use strict";
// 角色包发现层测试：以后上架新角色只靠「放目录 + 写一份 角色包.json」，
// 这一层读错，头像、默认背景整条外观链就断；读宽了，又把坏数据带进界面。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CP = require(path.join(__dirname, "..", "src", "character-pack.cjs"));
const REAL_ROOT = path.join(__dirname, "..", "characters");
const PACK = "角色包.json";

/** 改造前硬编码在前端的三个头像与默认背景，回落必须与它逐字一致。 */
const LEGACY = {
  avatars: [
    "assets/ellen/ellen-shortcut-avatar-v1.png",
    "assets/ellen/ellen-taskbar-chibi-v1.png",
    "assets/ellen/ellen-shark-hug-a5.png",
  ],
  background: "assets/ellen/room-approved-night-v1.png",
};

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ellen-pack-"));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePack(root, id, body) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, PACK), JSON.stringify(body));
  CP.clearCache();
}

function minimal(id, patch = {}) {
  return {
    id,
    name: "测试角色",
    version: 1,
    appearance: {
      uiBase: "assets/test/",
      avatars: [{ id: "main", label: "主头像", file: "main.png" }],
      background: "room.png",
    },
    ...patch,
  };
}

test("真实角色包全部能解析，没有坏包", () => {
  const ids = CP.listPacks(REAL_ROOT);
  assert.ok(ids.includes("ellen"), "ellen 应有角色包");
  assert.ok(ids.includes("ellen-lover"), "ellen-lover 应有角色包");
  const diag = CP.diagnostics(REAL_ROOT);
  assert.deepStrictEqual(diag.broken, [], `坏包：${JSON.stringify(diag.broken)}`);
  assert.strictEqual(diag.ok.length, ids.length, "每个包都应进 ok 列表");
});

test("内置角色的外观与改造前的硬编码逐字一致", () => {
  const fallback = CP.appearanceFor(null);
  assert.deepStrictEqual(fallback.avatars.map((a) => a.file), LEGACY.avatars);
  assert.strictEqual(fallback.background, LEGACY.background);
  assert.strictEqual(fallback.cardId, null);

  const lover = CP.appearanceFor("ellen-lover", REAL_ROOT);
  assert.deepStrictEqual(lover.avatars.map((a) => a.file), LEGACY.avatars);
  assert.strictEqual(lover.background, LEGACY.background);
  assert.deepStrictEqual(lover.avatars.map((a) => a.id), ["classic", "smile", "sleepy"]);
  assert.strictEqual(lover.avatars[0].label, "冷淡艾莲");
});

test("前端拿到的都已是 src/ui 下的相对路径", () => {
  for (const cardId of CP.listPacks(REAL_ROOT)) {
    const pack = CP.readPack(cardId, REAL_ROOT);
    const files = [...pack.appearance.avatars.map((a) => a.file), pack.appearance.background];
    for (const file of files) {
      assert.ok(file.startsWith("assets/"), `${cardId} 的 ${file} 应以 assets/ 开头`);
      assert.ok(!file.includes(".."), `${cardId} 的 ${file} 不能带上级目录`);
      assert.ok(!path.isAbsolute(file), `${cardId} 的 ${file} 不能是绝对路径`);
    }
  }
});

test("role 解析按最长前缀选 cardId，ellen 与 ellen-lover 不混", () => {
  assert.strictEqual(CP.cardIdFromRole("builtin-ellen-lover-trial-v3-20260930-95a1edae", REAL_ROOT), "ellen-lover");
  assert.strictEqual(CP.cardIdFromRole("builtin-ellen-any-profile", REAL_ROOT), "ellen");
  assert.strictEqual(CP.cardIdFromRole("builtin-ellen-lover-x", REAL_ROOT), "ellen-lover");
});

test("非内置 role 不猜 cardId", () => {
  assert.strictEqual(CP.cardIdFromRole("role-1234abcd", REAL_ROOT), null);
  assert.strictEqual(CP.cardIdFromRole("builtin-", REAL_ROOT), null);
  assert.strictEqual(CP.cardIdFromRole("builtin-ellen-", REAL_ROOT), null);
  assert.strictEqual(CP.cardIdFromRole(null, REAL_ROOT), null);
  assert.strictEqual(CP.cardIdFromRole(123, REAL_ROOT), null);
});

test("没有角色包的目录不算包，也不报错", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "no-pack"), { recursive: true });
  assert.deepStrictEqual(CP.listPacks(root), []);
  assert.strictEqual(CP.readPack("no-pack", root), null);
  assert.deepStrictEqual(CP.diagnostics(root), { ok: [], broken: [] });
});

test("包里的 id 必须和目录名一致", () => {
  const root = tempRoot();
  writePack(root, "ellen", minimal("ellen-lover"));
  assert.throws(() => CP.readPack("ellen", root), /目录名不一致/);
  assert.strictEqual(CP.diagnostics(root).broken.length, 1);
});

test("头像文件拒绝路径穿越、盘符、绝对路径", () => {
  const root = tempRoot();
  const bad = ["../../secret.png", "C:/win.png", "/etc/passwd", "a\\b.png", ""];
  for (const file of bad) {
    writePack(root, "ellen", {
      ...minimal("ellen"),
      appearance: { uiBase: "assets/test/", avatars: [{ id: "main", label: "主", file }], background: null },
    });
    assert.throws(() => CP.readPack("ellen", root), /相对文件名|上级目录或盘符/, `应拒绝：${file}`);
  }
});

test("头像清单不接受空数组、重复 id、野生 id", () => {
  const root = tempRoot();

  writePack(root, "ellen", { ...minimal("ellen"), appearance: { avatars: [], background: null } });
  assert.throws(() => CP.readPack("ellen", root), /至少需要一张头像/);

  writePack(root, "ellen", {
    ...minimal("ellen"),
    appearance: {
      avatars: [
        { id: "same", label: "甲", file: "a.png" },
        { id: "same", label: "乙", file: "b.png" },
      ],
      background: null,
    },
  });
  assert.throws(() => CP.readPack("ellen", root), /头像 id 重复/);

  writePack(root, "ellen", {
    ...minimal("ellen"),
    appearance: { avatars: [{ id: "Main", label: "大寫", file: "a.png" }], background: null },
  });
  assert.throws(() => CP.readPack("ellen", root), /小写字母、数字和连字符/);
});

test("background 可以留空，表示这套立绘没有配房间图", () => {
  const root = tempRoot();
  writePack(root, "ellen", { ...minimal("ellen"), appearance: { avatars: [{ id: "main", label: "主", file: "m.png" }], background: null } });
  const pack = CP.readPack("ellen", root);
  assert.strictEqual(pack.appearance.background, null);
  assert.strictEqual(pack.appearance.avatars[0].file, "assets/ellen/m.png");
});

test("角色包写坏了不影响外观面板，只是回落到内置", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "ellen"), { recursive: true });
  fs.writeFileSync(path.join(root, "ellen", PACK), "{ 这不是 JSON");
  CP.clearCache();
  const view = CP.appearanceForRole("builtin-ellen-x", root);
  assert.strictEqual(view.cardId, null, "坏包应回落");
  assert.deepStrictEqual(view.avatars.map((a) => a.file), LEGACY.avatars);
  assert.strictEqual(CP.diagnostics(root).broken.length, 1, "但体检要能看到它");
});

test("未知 role 直接给内置外观", () => {
  const view = CP.appearanceForRole("role-deadbeef", REAL_ROOT);
  assert.strictEqual(view.cardId, null);
  assert.strictEqual(view.background, LEGACY.background);
});

test("改角色包后会重新读，不会一直用缓存", () => {
  const root = tempRoot();
  writePack(root, "ellen", minimal("ellen"));
  assert.strictEqual(CP.readPack("ellen", root).name, "测试角色");
  writePack(root, "ellen", { ...minimal("ellen"), name: "改过的名字" });
  assert.strictEqual(CP.readPack("ellen", root).name, "改过的名字");
});

test("小人素材同样只接受干净相对路径", () => {
  const root = tempRoot();
  writePack(root, "ellen", { ...minimal("ellen"), mascot: { stand: "mascot/stand.png", size: 168 } });
  const pack = CP.readPack("ellen", root);
  assert.strictEqual(pack.mascot.stand, "assets/test/mascot/stand.png");
  assert.strictEqual(pack.mascot.size, 168);

  writePack(root, "ellen", { ...minimal("ellen"), mascot: { stand: "../escape.png" } });
  assert.throws(() => CP.readPack("ellen", root), /相对文件名|上级目录或盘符/);
});

test("头像 id 只做格式校验，具体有哪些由角色包决定", () => {
  assert.strictEqual(CP.isValidAvatarId("classic"), true);
  assert.strictEqual(CP.isValidAvatarId("miku-01"), true);
  assert.strictEqual(CP.isValidAvatarId("../../x"), false);
  assert.strictEqual(CP.isValidAvatarId(""), false);
  assert.strictEqual(CP.isValidAvatarId(null), false);
  assert.throws(() => CP.normalizeId("Bad Id", "角色 id"), /小写字母、数字和连字符/);
});
