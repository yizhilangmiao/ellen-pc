"use strict";
// 外观界面测试：真把 src/ui/appearance.js 放进最小 DOM 里跑一遍。
// 守的是「上架新角色时界面不认艾莲」——头像清单、标签、默认背景必须全部来自角色包，
// 而不是改完发现头像格子还是那三张、点开还是艾莲的脸。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "src", "ui", "appearance.js"), "utf8");
const BASE = "file:///E:/ailian/%E8%89%BE%E8%8E%B2%E7%94%B5%E8%84%91%E7%89%88/app/src/ui/index.html";

/** appearance.js 用到的全部 id，都是它自己 innerHTML 写出来的节点。 */
const IDS = [
  "appearance-title", "appearance-close", "appearance-avatar-pane", "appearance-avatars",
  "appearance-avatar-reset", "appearance-tab-avatar", "appearance-tab-background",
  "appearance-background-pane", "appearance-preview", "appearance-choose",
  "appearance-background-reset", "appearance-fit", "appearance-fit-note",
  "appearance-position", "appearance-x", "appearance-y", "appearance-center",
  "appearance-status",
];

function makeElement(tag = "div") {
  const style = new Map();
  const classes = new Set();
  const listeners = {};
  return {
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {
      setProperty: (name, value) => style.set(name, value),
      removeProperty: (name) => style.delete(name),
      getPropertyValue: (name) => style.get(name) ?? "",
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    children: [],
    attrs: {},
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    open: false,
    scrollTop: 0,
    _html: "",
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = value;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    append(...items) {
      for (const item of items) this.children.push(item);
    },
    replaceChildren(...items) {
      this.children = [...items];
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    focus() {},
    querySelector() {
      return makeElement("input");
    },
    querySelectorAll() {
      return [];
    },
  };
}

/**
 * 造一个只够 appearance.js 跑的宇宙；state 由调用方给，模拟主进程返回。
 */
function runAppearance(state) {
  const byId = new Map(IDS.map((id) => [id, makeElement()]));
  const body = makeElement("body");
  const sandbox = {
    document: {
      baseURI: BASE,
      body,
      getElementById: (id) => byId.get(id) ?? null,
      createElement: (tag) => makeElement(tag),
      querySelectorAll: () => [],
      querySelector: () => makeElement("input"),
      dispatchEvent: () => true,
      addEventListener: () => {},
    },
    Image: class {
      constructor() {
        this.src = "";
        this.naturalWidth = 1;
        this.naturalHeight = 1;
      }
      decode() {
        return Promise.resolve();
      }
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    URL,
    Promise,
    setTimeout,
    clearTimeout,
    console,
    companion: { invoke: async (domain, payload) => (payload?.type === "state" ? state : null) },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "appearance.js" });
  return { sandbox, body, byId };
}

const PACK_ELLEN = {
  cardId: "ellen-lover",
  name: "艾莲",
  uiBase: "assets/ellen/",
  avatars: [
    { id: "classic", label: "冷淡艾莲", file: "assets/ellen/ellen-shortcut-avatar-v1.png" },
    { id: "smile", label: "笑眯眯", file: "assets/ellen/ellen-taskbar-chibi-v1.png" },
    { id: "sleepy", label: "抱鲨睡觉", file: "assets/ellen/ellen-shark-hug-a5.png" },
  ],
  background: "assets/ellen/room-approved-night-v1.png",
};

const EMPTY_STATE = { version: 1, revision: 0, avatar: null, background: null, fit: "contain", x: 50, y: 50, role: "r", pack: PACK_ELLEN };

test("面板一打开就按角色包铺好头像格子", async () => {
  const { sandbox, byId } = runAppearance(EMPTY_STATE);
  await sandbox.ellenAppearance.ready;
  const box = byId.get("appearance-avatars");
  assert.strictEqual(box.children.length, 3);
  assert.deepStrictEqual(box.children.map((b) => b.dataset.avatar), ["classic", "smile", "sleepy"]);
  assert.deepStrictEqual(box.children.map((b) => b.children[1].textContent), ["冷淡艾莲", "笑眯眯", "抱鲨睡觉"]);
  for (const button of box.children) {
    const img = button.children[0];
    assert.ok(img.src.startsWith("file:///"), `头像应是绝对 URL，实际 ${img.src}`);
    assert.ok(img.src.includes("/src/ui/assets/ellen/"), `头像应落在 src/ui 下，实际 ${img.src}`);
  }
});

test("默认背景来自角色包，不是写死的房间图", async () => {
  const { sandbox, body } = runAppearance(EMPTY_STATE);
  await sandbox.ellenAppearance.ready;
  const image = body.style.getPropertyValue("--appearance-image");
  assert.ok(image.includes("room-approved-night-v1.png"), `实际 ${image}`);
});

test("换一个角色：头像、标签、背景整套换掉", async () => {
  const pack = {
    cardId: "miku",
    name: "初音",
    uiBase: "assets/miku/",
    avatars: [
      { id: "stand", label: "立绘", file: "assets/miku/stand.png" },
      { id: "chibi", label: "Q版", file: "assets/miku/chibi.png" },
    ],
    background: "assets/miku/stage.png",
  };
  const { sandbox, byId, body } = runAppearance({ ...EMPTY_STATE, pack });
  await sandbox.ellenAppearance.ready;
  const box = byId.get("appearance-avatars");
  assert.strictEqual(box.children.length, 2);
  assert.deepStrictEqual(box.children.map((b) => b.dataset.avatar), ["stand", "chibi"]);
  assert.deepStrictEqual(box.children.map((b) => b.children[1].textContent), ["立绘", "Q版"]);
  assert.ok(box.children[0].children[0].src.includes("/src/ui/assets/miku/stand.png"));
  assert.ok(body.style.getPropertyValue("--appearance-image").includes("/src/ui/assets/miku/stage.png"));
  assert.ok(!body.style.getPropertyValue("--appearance-image").includes("ellen"), "不该还留着艾莲的房间图");
});

test("选了头像就把它挂到 body 上", async () => {
  const { sandbox, body } = runAppearance({ ...EMPTY_STATE, avatar: "smile" });
  await sandbox.ellenAppearance.ready;
  assert.strictEqual(body.classList.contains("appearance-avatar"), true);
  const value = body.style.getPropertyValue("--appearance-avatar");
  assert.ok(value.startsWith('url("file:///'), `实际 ${value}`);
  assert.ok(value.includes("ellen-taskbar-chibi-v1.png"), `实际 ${value}`);
});

test("没选头像时不挂 class，走主题默认（与改造前一致）", async () => {
  const { sandbox, body } = runAppearance(EMPTY_STATE);
  await sandbox.ellenAppearance.ready;
  assert.strictEqual(body.classList.contains("appearance-avatar"), false);
  assert.strictEqual(body.style.getPropertyValue("--appearance-avatar"), "");
});

test("没有 pack 时回落内置三张，面板不留空白", async () => {
  const { sandbox, byId } = runAppearance({ ...EMPTY_STATE, pack: undefined });
  await sandbox.ellenAppearance.ready;
  const box = byId.get("appearance-avatars");
  assert.strictEqual(box.children.length, 3, "初始化就该有兜底三张");
  assert.deepStrictEqual(box.children.map((b) => b.dataset.avatar), ["classic", "smile", "sleepy"]);
});

test("pack 晚到也不会把头像格子刷成两倍", async () => {
  const { sandbox, byId } = runAppearance(EMPTY_STATE);
  await sandbox.ellenAppearance.ready;
  const box = byId.get("appearance-avatars");
  const before = box.children.length;
  await sandbox.ellenAppearance.open("avatar");
  assert.strictEqual(box.children.length, before, "重建前必须清空，不能追加");
});

test("自定义背景时预览与 body 都用用户的图", async () => {
  const url = "companion-appearance://image/abc/def.png";
  const { sandbox, body } = runAppearance({
    ...EMPTY_STATE,
    background: { width: 100, height: 100, available: true, url },
    fit: "cover",
  });
  await sandbox.ellenAppearance.ready;
  assert.ok(body.style.getPropertyValue("--appearance-image").includes(url));
  assert.strictEqual(body.dataset.backgroundFit, "cover");
  assert.strictEqual(body.classList.contains("custom-wallpaper"), true);
});
