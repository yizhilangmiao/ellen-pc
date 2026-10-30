"use strict";
/**
 * 角色包发现层（只读）。
 *
 * 目的：把「一个角色」的外观与素材声明从代码里搬到 characters/<cardId>/角色包.json，
 * 上架新角色 = 放一个目录 + 写一份 角色包.json，不改代码。
 *
 * 这一层只读盘、不写盘、不碰外观设置；任何调用方拿到的都是拷贝。
 * 没有角色包时一律回落到改造前的内置默认值，保证老数据与老界面不受影响。
 */
const fs = require("node:fs");
const path = require("node:path");

const PACK_FILE = "角色包.json";
const cardsRoot = path.resolve(__dirname, "../characters");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REL_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,119}$/;

/** 改造前的内置外观，保持逐字一致：任何回落都必须还原到这里。 */
const FALLBACK_APPEARANCE = Object.freeze({
  uiBase: "assets/ellen/",
  avatars: Object.freeze([
    Object.freeze({ id: "classic", label: "冷淡艾莲", file: "ellen-shortcut-avatar-v1.png" }),
    Object.freeze({ id: "smile", label: "笑眯眯", file: "ellen-taskbar-chibi-v1.png" }),
    Object.freeze({ id: "sleepy", label: "抱鲨睡觉", file: "ellen-shark-hug-a5.png" }),
  ]),
  background: "room-approved-night-v1.png",
});

const cache = new Map();

function fail(message) {
  throw Error(message);
}

/** 只接受字符集干净、无穿越、无盘符的相对路径。 */
function normalizeFile(value, what) {
  if (typeof value !== "string" || !REL_FILE_RE.test(value)) {
    fail(`${what}必须是相对文件名。`);
  }
  if (value.includes("..") || value.includes("\\") || value.includes(":") || value.startsWith("/")) {
    fail(`${what}不能包含上级目录或盘符。`);
  }
  return value;
}

function normalizeId(value, what) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    fail(`${what}只能是小写字母、数字和连字符。`);
  }
  return value;
}

function packPath(root, cardId) {
  return path.join(root, cardId, PACK_FILE);
}

/**
 * 把角色包里的 appearance 段整理成前端可直接用的形状：
 * 相对 src/ui/ 的完整路径由这里拼好，前端只管 new URL(rel, document.baseURI)。
 */
function normalizeAppearance(raw, cardId) {
  if (null === raw) return cloneAppearance(FALLBACK_APPEARANCE);
  if ("object" !== typeof raw || Array.isArray(raw)) {
    fail(`${cardId} 的外观段必须是对象。`);
  }
  const uiBase = normalizeFile(raw.uiBase ?? FALLBACK_APPEARANCE.uiBase, "外观素材目录");
  const base = uiBase.endsWith("/") ? uiBase : `${uiBase}/`;
  const list = raw.avatars;
  if (!Array.isArray(list) || 0 === list.length) {
    fail(`${cardId} 的外观至少需要一张头像。`);
  }
  const seen = new Set();
  const avatars = list.map((item, index) => {
    if ("object" !== typeof item || Array.isArray(item)) {
      fail(`${cardId} 的第 ${index + 1} 张头像格式不对。`);
    }
    const id = normalizeId(item.id, "头像 id");
    if (seen.has(id)) fail(`${cardId} 的头像 id 重复：${id}`);
    seen.add(id);
    const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : id;
    const file = normalizeFile(item.file, `${cardId} 的头像文件`);
    return { id, label, file: `${base}${file}` };
  });
  const background =
    null === raw.background || undefined === raw.background
      ? null
      : `${base}${normalizeFile(raw.background, `${cardId} 的默认背景`)}`;
  return { uiBase: base, avatars, background };
}

function cloneAppearance(appearance) {
  return {
    uiBase: appearance.uiBase,
    avatars: appearance.avatars.map((avatar) => ({
      id: avatar.id,
      label: avatar.label,
      file: `${appearance.uiBase}${avatar.file}`,
    })),
    background: null === appearance.background ? null : `${appearance.uiBase}${appearance.background}`,
  };
}

function readJson(file) {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = cache.get(file);
  if (hit && hit.key === key) return hit.value;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  cache.set(file, { key, value });
  return value;
}

/**
 * 读一个角色的包。没有包返回 null（不算错误）；包存在但写坏了才抛错，
 * 这样「新角色忘了写包」不会炸，而「包写错字段」会立刻暴露。
 */
function readPack(cardId, root = cardsRoot) {
  const id = normalizeId(cardId, "角色 id");
  const file = packPath(root, id);
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = readJson(file);
  } catch (error) {
    fail(`${id} 的角色包无法解析：${error.message}`);
  }
  if ("object" !== typeof raw || Array.isArray(raw)) {
    fail(`${id} 的角色包必须是对象。`);
  }
  if (raw.id !== id) {
    fail(`${id} 的角色包里 id 写成了 ${String(raw.id)}，与目录名不一致。`);
  }
  const appearance = normalizeAppearance(raw.appearance ?? null, id);
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    version: Number.isSafeInteger(raw.version) ? raw.version : 1,
    appearance,
    mascot: normalizeMascot(raw.mascot ?? null, id, appearance.uiBase),
    books: Array.isArray(raw.books) ? raw.books.filter((item) => "string" == typeof item) : [],
    theme: typeof raw.theme === "string" && ID_RE.test(raw.theme) ? raw.theme : id,
  };
}

/** 小人素材只做声明与校验，怎么用由桌面小人模块决定。 */
function normalizeMascot(raw, cardId, defaultBase = FALLBACK_APPEARANCE.uiBase) {
  if (null === raw || undefined === raw) return null;
  if ("object" !== typeof raw || Array.isArray(raw)) {
    fail(`${cardId} 的小人段必须是对象。`);
  }
  // 小人素材默认跟外观共用同一个目录，角色包不用把 uiBase 写两遍。
  const uiBase = normalizeFile(raw.uiBase ?? defaultBase, "小人素材目录");
  const base = uiBase.endsWith("/") ? uiBase : `${uiBase}/`;
  const out = { uiBase: base };
  if (raw.stand) out.stand = `${base}${normalizeFile(raw.stand, `${cardId} 的小人立绘`)}`;
  if (raw.swim) out.swim = `${base}${normalizeFile(raw.swim, `${cardId} 的小人泳姿图`)}`;
  if (raw.rest) out.rest = `${base}${normalizeFile(raw.rest, `${cardId} 的小人静止图`)}`;
  if (Number.isFinite(raw.size) && raw.size > 0 && raw.size <= 1024) out.size = Math.round(raw.size);
  return out;
}

/** 扫 characters/ 下所有带角色包的目录，返回 cardId 列表（排序稳定）。 */
function listPacks(root = cardsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
    .filter((entry) => fs.existsSync(packPath(root, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

/** 体检用：把写坏的角色包挑出来，不抛错。 */
function diagnostics(root = cardsRoot) {
  const broken = [];
  const ok = [];
  for (const cardId of listPacks(root)) {
    try {
      const pack = readPack(cardId, root);
      ok.push({ id: cardId, name: pack.name, avatars: pack.appearance.avatars.length, mascot: !!pack.mascot });
    } catch (error) {
      broken.push({ id: cardId, message: error.message });
    }
  }
  return { ok, broken };
}

/**
 * role 形如 builtin-<cardId>-<profileId>。
 * cardId 本身可能带连字符（ellen / ellen-lover），所以按已知角色包做最长前缀匹配，
 * 不猜、不切分。
 */
function cardIdFromRole(role, root = cardsRoot) {
  if ("string" != typeof role || !role.startsWith("builtin-")) return null;
  const candidates = listPacks(root).sort((a, b) => b.length - a.length);
  for (const cardId of candidates) {
    const prefix = `builtin-${cardId}-`;
    if (role.startsWith(prefix) && role.length > prefix.length) return cardId;
  }
  return null;
}

/** 前端外观层真正要的那一小块：头像清单 + 默认背景，路径已拼好。 */
function appearanceFor(cardId, root = cardsRoot) {
  const pack = cardId ? readPack(cardId, root) : null;
  if (!pack) return { cardId: null, name: null, ...cloneAppearance(FALLBACK_APPEARANCE) };
  return { cardId: pack.id, name: pack.name, ...pack.appearance };
}

function appearanceForRole(role, root = cardsRoot) {
  const cardId = cardIdFromRole(role, root);
  if (!cardId) return appearanceFor(null, root);
  try {
    return appearanceFor(cardId, root);
  } catch {
    // 角色包写坏了不该让整个外观面板打不开，回落到内置，错误由 diagnostics() 暴露。
    return appearanceFor(null, root);
  }
}

/** 头像 id 是否合法：后端只做格式校验，具体有哪些由角色包决定。 */
function isValidAvatarId(value) {
  return "string" == typeof value && ID_RE.test(value);
}

function clearCache() {
  cache.clear();
}

module.exports = {
  PACK_FILE,
  FALLBACK_APPEARANCE,
  cardIdFromRole,
  appearanceFor,
  appearanceForRole,
  diagnostics,
  isValidAvatarId,
  listPacks,
  normalizeId,
  readPack,
  clearCache,
};
