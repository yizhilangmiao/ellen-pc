"use strict";
// 外观动作层测试：界面拿到的 state 里必须带上角色包的立绘清单，
// 否则前端只能回落硬编码，换角色就还是艾莲的脸。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { AppearanceStore } = require(path.join(__dirname, "..", "src", "appearance-store.cjs"));
const { createAppearanceActions } = require(path.join(__dirname, "..", "src", "appearance-actions.cjs"));

const ROLE = "builtin-ellen-lover-trial-v3-20260930-95a1edae";

function makeActions(role = ROLE) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ellen-appearance-actions-"));
  test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AppearanceStore({ dataDir });
  const actions = createAppearanceActions({
    store,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
    getWindow: () => null,
    getRole: () => role,
  });
  return { actions, store };
}

test("state 带回当前角色包的头像清单与默认背景", async () => {
  const { actions } = makeActions();
  const state = await actions({ type: "state" });
  assert.ok(state.pack, "state 必须带 pack");
  assert.strictEqual(state.pack.cardId, "ellen-lover");
  assert.strictEqual(state.pack.avatars.length, 3);
  assert.deepStrictEqual(state.pack.avatars.map((a) => a.id), ["classic", "smile", "sleepy"]);
  assert.ok(state.pack.background.startsWith("assets/ellen/"));
  for (const avatar of state.pack.avatars) {
    assert.ok(avatar.file.startsWith("assets/"), `${avatar.id} 的路径要能直接被前端 new URL 用`);
    assert.ok(avatar.label, `${avatar.id} 要有中文标签`);
  }
});

test("另一个内置角色拿到自己那份包", async () => {
  const { actions } = makeActions("builtin-ellen-anything");
  const state = await actions({ type: "state" });
  assert.strictEqual(state.pack.cardId, "ellen");
});

test("导入卡（role-uuid）回落内置外观，不报错", async () => {
  const { actions } = makeActions("role-0f1e2d3c");
  const state = await actions({ type: "state" });
  assert.strictEqual(state.pack.cardId, null);
  assert.strictEqual(state.pack.avatars.length, 3, "回落也要有三张，不能空白");
  assert.ok(state.pack.background.endsWith("room-approved-night-v1.png"));
});

test("原有设置照样生效，pack 不覆盖用户选择", async () => {
  const { actions, store } = makeActions();
  store.update(ROLE, { avatar: "smile", fit: "cover", x: 30 }, 0);
  const state = await actions({ type: "state" });
  assert.strictEqual(state.avatar, "smile");
  assert.strictEqual(state.fit, "cover");
  assert.strictEqual(state.x, 30);
  assert.strictEqual(state.pack.avatars.length, 3, "pack 只是候选清单，不该动当前值");
});

test("其他动作不受影响", async () => {
  const { actions } = makeActions();
  const saved = await actions({ type: "save", role: ROLE, revision: 0, patch: { avatar: "sleepy" } });
  assert.strictEqual(saved.avatar, "sleepy");
  // pack 只在 state 里带一次：面板打开时已经拿到清单，每写一次就重读一遍角色包没有意义。
  // 前端对没有 pack 的返回走同一条路径（k?.avatars?.length 为假即跳过），所以这里必须是 undefined 而不是空对象。
  assert.strictEqual(saved.pack, undefined);

  assert.strictEqual(await actions({ type: "chooseBackground", role: ROLE, revision: saved.revision }), null);

  const reset = await actions({ type: "resetBackground", role: ROLE, revision: saved.revision });
  assert.strictEqual(reset.background, null);
});

test("切了角色还拿旧 revision 来写会被挡", async () => {
  const { actions } = makeActions();
  await assert.rejects(() => actions({ type: "save", role: "builtin-ellen-x", revision: 0, patch: { avatar: "classic" } }), /当前角色已切换/);
});
