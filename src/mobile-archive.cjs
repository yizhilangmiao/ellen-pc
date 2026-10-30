"use strict";

// 手机端「资料文件」(.ellenpack) 的读取与写出（电脑端侧）。
//
// 容器格式来自原生 EllenArchivePlugin（classes.dex 里 MAGIC 常量 "ELLENPK1\n"）：
//
//   MAGIC "ELLENPK1\n" (9 字节, US-ASCII)
//   uint32 (大端) manifest 字节长度
//   manifest JSON (UTF-8)
//   按 manifest.files 顺序首尾相接的二进制块（无对齐、无压缩、无长度前缀）
//
// 每块的长度由清单里的 sizeBytes 决定，所以清单必须先读到底才能定位块。
// 清单里还可以有 version 2 的 selection / groupId / checksum（分类备份）。
//
// 全部规则对齐 0.1.20 的 web 侧校验（service chunk 里 Dh/Oh/jh/Mh/Ph/Ih/up/lp）：
//   - format 固定 "ellen-companion-archive"
//   - v1 严格字段 [format, version, package, files]
//   - v2 严格字段 [format, version, package, files, selection, groupId, checksum]，checksum = sha256(规范化 JSON 去掉 checksum)
//   - package 是 { content, checksum }，content 严格字段
//     [format, formatVersion, packageId, origin, exportedAt, snapshot, media]
//   - package.checksum = "sha256:" + sha256(规范化 JSON(content))
//   - files 每项严格字段 [id, sha256, sizeBytes, mimeType]，图片 ≤32MiB、其他 ≤128MiB，总数 ≤1GiB
//   - 清单 JSON ≤17 MiB
//
// 只读这一侧不依赖上面的严格校验也能工作：校验失败时把问题塞进 warnings，
// 内容照常解析，避免一个字段不符就整包读不出来。

const fs = require("node:fs");
const crypto = require("node:crypto");

const MAGIC = Buffer.from("ELLENPK1\n", "ascii");
const FORMAT = "ellen-companion-archive";
const TRANSFER = "ellen-companion-transfer";
const MiB = 1024 * 1024;
const MAX_MANIFEST = 17 * MiB;
const MAX_FILES = 10000;
const MAX_TOTAL_BYTES = 1024 * MiB;
const FILE_ITEM_KEYS = ["id", "sha256", "sizeBytes", "mimeType"];
const MIME_RE = /^(image|video|audio)\/[a-zA-Z0-9.+-]{1,50}$/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GROUP_RE = /^[a-zA-Z0-9:._-]{1,100}$/;

class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ArchiveError(code, message);
}

// ---------------------------------------------------------------- JSON 规范化

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// 与 web 侧 yr() 一致：对象键排序递归，数组保序，其余走 JSON.stringify。
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertJsonValue(value, depth) {
  const d = depth || 0;
  if (d > 32) fail("INVALID_JSON", "资料嵌套超过限制。");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_JSON", "资料不能包含非有限数值。");
    return;
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) fail("INVALID_JSON", "资料不能包含稀疏数组。");
    value.forEach((v) => assertJsonValue(v, d + 1));
    return;
  }
  if (!isPlainObject(value)) fail("INVALID_JSON", "资料必须为 JSON 值。");
  for (const [k, v] of Object.entries(value)) {
    if (k === "__proto__" || k === "prototype" || k === "constructor") fail("INVALID_JSON", "资料包含保留字段。");
    assertJsonValue(v, d + 1);
  }
}

function canonicalJsonStrict(value) {
  assertJsonValue(value);
  return canonicalJson(value);
}

// ---------------------------------------------------------------- 基础校验

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256Text(text) {
  return sha256Hex(Buffer.from(text, "utf8"));
}

function sameKeySet(obj, keys) {
  if (!isPlainObject(obj)) return false;
  const a = Object.keys(obj).sort().join("|");
  const b = [...keys].sort().join("|");
  return a === b;
}

function checkId(v, label) {
  if (typeof v !== "string" || !ID_RE.test(v)) fail("INVALID_ID", `${label || "id"} 无效。`);
}

function checkTime(v) {
  const ok =
    typeof v === "string" &&
    ISO_RE.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString() === v;
  if (!ok) fail("INVALID_TIME", "时间必须为有效的 UTC ISO 字符串。");
}

function checkFileItem(item) {
  if (!sameKeySet(item, FILE_ITEM_KEYS)) fail("INVALID_ARCHIVE_FILES", "文件清单字段无效。");
  checkId(item.id);
  if (!HEX64_RE.test(item.sha256)) fail("INVALID_ARCHIVE_FILES", "文件缺少有效摘要。");
  if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) {
    fail("INVALID_ARCHIVE_FILES", "文件缺少有效大小。");
  }
  if (typeof item.mimeType !== "string" || !MIME_RE.test(item.mimeType)) {
    fail("INVALID_ARCHIVE_FILES", "文件缺少有效媒体类型。");
  }
  const cap = (item.mimeType.startsWith("image/") ? 32 : 128) * MiB;
  if (item.sizeBytes > cap) fail("ARCHIVE_FILE_TOO_LARGE", "单个媒体超过资料文件容量限制。");
  return { ...item };
}

function checkFileList(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) {
    fail("INVALID_ARCHIVE_FILES", "文件清单超过10000项或格式无效。");
  }
  const list = files.map(checkFileItem);
  if (new Set(list.map((f) => f.id)).size !== list.length) {
    fail("INVALID_ARCHIVE_FILES", "资料文件标识重复。");
  }
  const total = list.reduce((n, f) => n + f.sizeBytes, 0);
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) {
    fail("ARCHIVE_TOO_LARGE", "媒体总量超过1GiB，未截断导出。");
  }
  return list;
}

// ---------------------------------------------------------------- 清单校验

async function checkPackage(pkg) {
  if (!sameKeySet(pkg, ["content", "checksum"])) fail("INVALID_PACKAGE", "资料包封装字段无效。");
  const { content, checksum } = pkg;
  if (!sameKeySet(content, ["format", "formatVersion", "packageId", "origin", "exportedAt", "snapshot", "media"])) {
    fail("INVALID_PACKAGE", "资料包内容字段无效。");
  }
  if (content.format !== TRANSFER || content.formatVersion !== 1) {
    fail("UNSUPPORTED_VERSION", "不支持此资料包格式或版本。");
  }
  checkId(content.packageId);
  checkTime(content.exportedAt);
  if (!sameKeySet(content.origin, ["deviceId", "platform"])) fail("INVALID_ORIGIN", "资料包来源无效。");
  checkId(content.origin.deviceId);
  checkId(content.origin.platform);
  if (
    !sameKeySet(content.media, ["mode", "requiredIds"]) ||
    content.media.mode !== "metadata-only" ||
    !Array.isArray(content.media.requiredIds)
  ) {
    fail("INVALID_MEDIA_MANIFEST", "媒体清单无效。");
  }
  const text = canonicalJsonStrict(content);
  if (typeof checksum !== "string" || !/^sha256:[a-f0-9]{64}$/.test(checksum)) {
    fail("CHECKSUM_MISMATCH", "资料包摘要格式无效。");
  }
  if (checksum !== `sha256:${sha256Text(text)}`) {
    fail("CHECKSUM_MISMATCH", "资料包摘要不一致。");
  }
  return { content, checksum };
}

// 返回 { manifest, version, packageContent, files, warnings }
// 严格校验失败不抛错（除结构性错误），只记 warning —— 只读场景优先把内容拿出来。
async function validateManifest(manifest) {
  const warnings = [];
  const note = (code, e) => warnings.push({ code, message: e.message });

  if (!isPlainObject(manifest)) fail("INVALID_ARCHIVE_MANIFEST", "资料文件清单不是有效对象。");
  if (manifest.format !== FORMAT) fail("INVALID_ARCHIVE_MANIFEST", "不是艾莲资料文件。");

  const version = manifest.version;
  const v1 = version === 1 && sameKeySet(manifest, ["format", "version", "package", "files"]);
  const v2 =
    version === 2 &&
    sameKeySet(manifest, ["format", "version", "package", "files", "selection", "groupId", "checksum"]);
  if (!v1 && !v2) fail("INVALID_ARCHIVE_MANIFEST", "不支持此资料文件格式或字段。");

  let files = [];
  try {
    files = checkFileList(manifest.files);
  } catch (e) {
    note(e.code || "INVALID_ARCHIVE_FILES", e);
    files = Array.isArray(manifest.files) ? manifest.files.slice() : [];
  }

  let packageContent = null;
  try {
    packageContent = (await checkPackage(manifest.package)).content;
  } catch (e) {
    note(e.code || "INVALID_PACKAGE", e);
    packageContent = isPlainObject(manifest.package) ? manifest.package.content : null;
  }

  if (v2) {
    try {
      if (manifest.groupId !== null && (typeof manifest.groupId !== "string" || !GROUP_RE.test(manifest.groupId))) {
        fail("INVALID_BACKUP_GROUP", "备份组标识无效。");
      }
      const { checksum, ...rest } = manifest;
      if (!HEX64_RE.test(checksum) || checksum !== sha256Text(canonicalJsonStrict(rest))) {
        fail("CHECKSUM_MISMATCH", "分类备份摘要不一致。");
      }
    } catch (e) {
      note(e.code || "CHECKSUM_MISMATCH", e);
    }
  }

  const rawLen = Buffer.byteLength(canonicalJsonStrict(manifest), "utf8");
  if (rawLen > MAX_MANIFEST) note("ARCHIVE_MANIFEST_TOO_LARGE", { message: "资料清单超过17MiB。" });

  return {
    manifest,
    version,
    isSelectionBackup: v2,
    files,
    packageContent,
    checksum: isPlainObject(manifest.package) ? manifest.package.checksum : null,
    warnings,
  };
}

// ---------------------------------------------------------------- 容器读取

// buf: Buffer（整个 .ellenpack）。返回 { manifest, files:[{...清单项, data}], manifestBytes, totalBytes }
async function parseArchiveBuffer(buf) {
  if (!Buffer.isBuffer(buf)) fail("INVALID_ARCHIVE", "需要 Buffer。");
  if (buf.length < MAGIC.length + 4) fail("INVALID_ARCHIVE", "文件太短，不是资料文件。");
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    fail("INVALID_ARCHIVE", "文件头不是 ELLENPK1，不是艾莲资料文件。");
  }
  const manifestLen = buf.readUInt32BE(MAGIC.length);
  const headEnd = MAGIC.length + 4;
  const bodyStart = headEnd + manifestLen;
  if (manifestLen <= 0 || bodyStart > buf.length) fail("INVALID_ARCHIVE_CHUNK", "清单长度超出文件范围。");

  const manifestText = buf.subarray(headEnd, bodyStart).toString("utf8");
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    fail("INVALID_ARCHIVE_MANIFEST", "资料文件清单不是有效 JSON。");
  }

  const checked = await validateManifest(manifest);
  const files = [];
  let offset = bodyStart;
  for (const item of checked.files) {
    const end = offset + item.sizeBytes;
    if (end > buf.length) fail("INVALID_ARCHIVE_CHUNK", `文件 ${item.id} 超出文件范围。`);
    const data = buf.subarray(offset, end);
    files.push({ ...item, offset, data });
    offset = end;
  }
  return {
    ...checked,
    files,
    manifestBytes: manifestLen,
    declaredBytes: bodyStart + checked.files.reduce((n, f) => n + f.sizeBytes, 0),
    totalBytes: buf.length,
    trailingBytes: buf.length - offset,
  };
}

async function readArchive(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) fail("INVALID_ARCHIVE", "请选择一个资料文件。");
  return parseArchiveBuffer(fs.readFileSync(filePath));
}

// 「导入」按钮只弹一次文件框，靠后缀判断该走哪条链。
// 手机端导出的是 .ellenPack（大写 P），Windows 上大小写不敏感，这里统一忽略大小写。
const MOBILE_EXT_RE = /\.ellenpack$/i;

function isMobileArchivePath(filePath) {
  return MOBILE_EXT_RE.test(String(filePath || ""));
}

// ---------------------------------------------------------------- 容器写出

// files: [{ id, sha256, sizeBytes, mimeType, data: Buffer }]
function writeArchive({ manifest, files }) {
  const manifestText = JSON.stringify(manifest);
  const manifestBuf = Buffer.from(manifestText, "utf8");
  if (manifestBuf.length > MAX_MANIFEST) fail("ARCHIVE_MANIFEST_TOO_LARGE", "资料清单超过17MiB。");
  const head = Buffer.alloc(MAGIC.length + 4);
  MAGIC.copy(head, 0);
  head.writeUInt32BE(manifestBuf.length, MAGIC.length);
  const parts = [head, manifestBuf];
  for (const f of files || []) {
    if (!Buffer.isBuffer(f.data)) fail("INVALID_ARCHIVE_CHUNK", `文件 ${f.id} 缺少内容。`);
    if (f.data.length !== f.sizeBytes) fail("INVALID_ARCHIVE_CHUNK", `文件 ${f.id} 大小与清单不一致。`);
    parts.push(f.data);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- 快照展开

// 手机端快照是 revision 模型：{ schemaVersion, profiles, records:[{id, revisionId, parents, at, kind, profileId, deleted, refs, value}] }
// 这里复刻 web 侧 X()：去掉作为别人 parent 的 revision，再按 id 分组取当前视图。
function expandRecords(snapshot) {
  const records = Array.isArray(snapshot && snapshot.records) ? snapshot.records : [];
  const parents = new Set();
  for (const r of records) {
    if (Array.isArray(r.parents)) for (const p of r.parents) parents.add(p);
  }
  const byId = new Map();
  for (const r of records) {
    if (parents.has(r.revisionId)) continue;
    let entry = byId.get(r.id);
    if (!entry) {
      entry = { id: r.id, kind: r.kind, profileId: r.profileId, revisions: [] };
      byId.set(r.id, entry);
    }
    entry.revisions.push(r);
  }
  const out = [];
  for (const entry of byId.values()) {
    entry.revisions.sort((a, b) => String(a.revisionId).localeCompare(String(b.revisionId)));
    const last = entry.revisions[entry.revisions.length - 1];
    out.push({
      id: entry.id,
      kind: entry.kind,
      profileId: entry.profileId,
      revisionId: last && last.revisionId,
      at: last && last.at,
      conflict: entry.revisions.length > 1,
      deleted: entry.revisions.length === 1 && entry.revisions[0].deleted === true,
      value: (last && last.value) || {},
      refs: (last && last.refs) || [],
      revisions: entry.revisions,
    });
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return out;
}

function pickText(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (Array.isArray(value.parts) && value.parts.every((p) => typeof p === "string")) return value.parts.join("");
  return "";
}

// 手机快照 → 电脑端 chat-io 的 ellen-chat-export 形态
function toChatExport(snapshot, { character } = {}) {
  const records = expandRecords(snapshot);
  const threads = records.filter((r) => r.kind === "thread" && !r.deleted);
  const messages = records.filter((r) => r.kind === "message" && !r.deleted);

  const byThread = new Map();
  for (const m of messages) {
    const tid = m.value && m.value.threadId;
    if (typeof tid !== "string") continue;
    if (!byThread.has(tid)) byThread.set(tid, []);
    byThread.get(tid).push(m);
  }

  const conversations = [];
  for (const t of threads) {
    const list = (byThread.get(t.id) || []).slice().sort((a, b) => {
      const ta = String((a.value && a.value.createdAt) || a.at || "");
      const tb = String((b.value && b.value.createdAt) || b.at || "");
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.id).localeCompare(String(b.id));
    });
    const title = (t.value && t.value.title) || "未命名聊天";
    const createdAt = (t.value && t.value.createdAt) || t.at || null;
    let updatedAt = t.at || createdAt;
    for (const m of list) {
      const at = (m.value && m.value.createdAt) || m.at;
      if (at && (!updatedAt || String(at) > String(updatedAt))) updatedAt = at;
    }
    conversations.push({
      title,
      createdAt,
      updatedAt,
      messages: list.map((m) => {
        const v = m.value || {};
        const out = {
          role: v.role === "assistant" ? "assistant" : "user",
          text: pickText(v),
          createdAt: v.createdAt || m.at || null,
        };
        if (v.status) out.origin = v.status;
        return out;
      }),
    });
  }
  conversations.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

  return {
    format: "ellen-chat-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    character: character || null,
    conversations,
  };
}

// 顺带把其它记录种类统计出来，供预览用
function summarizeSnapshot(snapshot) {
  const records = expandRecords(snapshot);
  const counts = {};
  let deleted = 0;
  for (const r of records) {
    if (r.deleted) {
      deleted += 1;
      continue;
    }
    counts[r.kind] = (counts[r.kind] || 0) + 1;
  }
  const profiles = Array.isArray(snapshot && snapshot.profiles) ? snapshot.profiles : [];
  return {
    schemaVersion: snapshot && snapshot.schemaVersion,
    records: records.length,
    deletedRecords: deleted,
    byKind: counts,
    profiles: profiles.length,
    revisions: Array.isArray(snapshot && snapshot.records) ? snapshot.records.length : 0,
    conflicts: records.filter((r) => r.conflict && !r.deleted).length,
  };
}

function buildMarkdown(payload) {
  const ROLE_LABEL = { user: "你", assistant: "艾莲" };
  const pad = (n) => String(n).padStart(2, "0");
  const humanTime = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const name = (payload.character && payload.character.name) || "艾莲";
  const L = [];
  L.push(`# ${name} · 聊天记录`);
  L.push("");
  L.push(`导出时间：${humanTime(payload.exportedAt)}　共 ${payload.conversations.length} 段聊天`);
  payload.conversations.forEach((c) => {
    L.push("");
    L.push("---");
    L.push("");
    L.push(`## ${c.title || "未命名聊天"}`);
    L.push("");
    L.push(`开始于 ${humanTime(c.createdAt)}`);
    L.push("");
    (c.messages || []).forEach((m) => {
      const who = ROLE_LABEL[m.role] || m.role;
      L.push(`**${who}** · ${humanTime(m.createdAt)}`);
      L.push("");
      L.push(m.text || "");
      L.push("");
    });
  });
  return L.join("\n");
}

// ---------------------------------------------------------------- 落到电脑端

const chatIO = require("./chat-io.cjs");

const FATAL_WARNINGS = new Set([
  "CHECKSUM_MISMATCH",
  "INVALID_PACKAGE",
  "INVALID_ARCHIVE_FILES",
  "UNSUPPORTED_VERSION",
  "INVALID_MEDIA_MANIFEST",
]);

// 手机端 .ellenpack → 电脑端聊天记录。
// 先选文件（或给定 filePath），校验清单，把快照里的 thread/message 转成
// ellen-chat-export 形态，再交给 chat-io 的 applyImport 写进当前角色的聊天记录。
async function importMobileArchive({ store, character, dialog, getWindow, filePath }) {
  let file = filePath;
  if (!file) {
    if (!dialog || typeof dialog.showOpenDialog !== "function") fail("INVALID_ARCHIVE", "缺少文件选择对话框。");
    const opts = {
      title: "从手机资料文件导入",
      properties: ["openFile"],
      filters: [{ name: "艾莲资料文件", extensions: ["ellenpack"] }],
    };
    const win = typeof getWindow === "function" ? getWindow() : null;
    const r = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
    if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    file = r.filePaths[0];
  }

  const archive = await readArchive(file);
  const fatal = archive.warnings.filter((w) => FATAL_WARNINGS.has(w.code));
  if (fatal.length) {
    fail(
      fatal[0].code,
      `这份资料文件没有通过校验（${fatal[0].message || fatal[0].code}），为避免写坏记录已停止导入。`
    );
  }
  if (!archive.packageContent || !archive.packageContent.snapshot) {
    fail("INVALID_PACKAGE", "资料文件里没有聊天快照。");
  }

  const summary = summarizeSnapshot(archive.packageContent.snapshot);
  const payload = toChatExport(archive.packageContent.snapshot, { character });
  if (!payload.conversations.length) fail("INVALID_ARCHIVE", "资料文件里没有可导入的聊天。");

  const result = chatIO.applyImport(store, payload);
  return {
    path: file,
    sizeBytes: archive.totalBytes,
    version: archive.version,
    isSelectionBackup: archive.isSelectionBackup,
    exportedAt: archive.packageContent.exportedAt,
    origin: archive.packageContent.origin,
    conversations: result.conversations,
    messages: result.messages,
    skipped: result.skipped,
    repeated: result.repeated || 0,
    ids: result.ids,
    warnings: archive.warnings.map((w) => w.code),
    summary,
  };
}

// 只读预览：不写任何记录，用来在导入前告诉用户包里有什么。
async function previewMobileArchive({ filePath }) {
  const archive = await readArchive(filePath);
  const snapshot = archive.packageContent && archive.packageContent.snapshot;
  return {
    path: filePath,
    sizeBytes: archive.totalBytes,
    declaredBytes: archive.declaredBytes,
    trailingBytes: archive.trailingBytes,
    version: archive.version,
    isSelectionBackup: archive.isSelectionBackup,
    exportedAt: archive.packageContent && archive.packageContent.exportedAt,
    origin: archive.packageContent && archive.packageContent.origin,
    files: (archive.files || []).map((f) => ({ id: f.id, mimeType: f.mimeType, sizeBytes: f.sizeBytes })),
    summary: snapshot ? summarizeSnapshot(snapshot) : null,
    chats: snapshot ? toChatExport(snapshot, {}).conversations.map((c) => ({ title: c.title, messages: c.messages.length })) : [],
    warnings: archive.warnings.map((w) => ({ code: w.code, message: w.message })),
  };
}

module.exports = {
  MAGIC,
  FORMAT,
  TRANSFER,
  ArchiveError,
  canonicalJson,
  canonicalJsonStrict,
  sha256Hex,
  sha256Text,
  validateManifest,
  parseArchiveBuffer,
  readArchive,
  writeArchive,
  isMobileArchivePath,
  expandRecords,
  toChatExport,
  summarizeSnapshot,
  buildMarkdown,
  checkFileList,
  checkPackage,
  importMobileArchive,
  previewMobileArchive,
};
