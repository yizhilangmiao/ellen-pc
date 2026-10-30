"use strict";

// 聊天记录的导入导出。
//
// 导出两种形态：
//   .json  —— 完整、可重新导入，是本功能的正式格式
//   .md    —— 方便直接阅读/贴到别处，不能导入
// 选哪种由保存对话框里文件名后缀决定，不额外弹窗。
//
// 只导出可跨机器还原的字段。通话录音(callId)、语音条(voiceDelivery)、
// 图片附件(attachments) 都指向本机文件，换台机器必然失效，
// 导出去只会变成坏图或空语音，所以直接丢弃。

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, createHash } = require("node:crypto");

const FORMAT = "ellen-chat-export";
const VERSION = 1;
const MAX_IMPORT = 64 * 1024 * 1024;
const MAX_TITLE = 80;

const ROLE_LABEL = { user: "你", assistant: "艾莲" };

function portableMessage(m) {
  const out = {
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
  };
  if (m.origin) out.origin = m.origin;
  if (m.stickerId) out.stickerId = m.stickerId;
  if (Array.isArray(m.replyParts) && m.replyParts.length) out.replyParts = m.replyParts;
  if (m.usage) out.usage = m.usage;
  return out;
}

function safeTitle(t, fallback) {
  let s = typeof t === "string" ? t.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!s) s = fallback;
  return s.slice(0, MAX_TITLE);
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// 一段聊天的内容指纹：标题 + 每条消息的「角色/时间/正文」。
// 同一个包重复导入时这段内容一字不差，指纹必然相同，用它挡住重复落库。
// 用 \u0001 / \u0002 / \u0003 当分隔符，正文里出现普通换行也不会撞。
function conversationFingerprint(title, messages) {
  const lines = (Array.isArray(messages) ? messages : []).map((m) => {
    const role = (m && m.role) || "";
    const at = (m && typeof m.createdAt === "string" ? m.createdAt : "") || "";
    const text = (m && typeof m.text === "string" ? m.text : "") || "";
    return `${role}\u0001${at}\u0001${text}`;
  });
  return createHash("sha256")
    .update(`${title}\u0002${lines.join("\u0003")}`)
    .digest("hex");
}

function humanTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildPayload(store, threads, character) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    character: character || null,
    conversations: threads.map((t) => ({
      title: t.title,
      createdAt: t.createdAt || t.updatedAt,
      updatedAt: t.updatedAt,
      messages: store.messages(t.id).map(portableMessage),
    })),
  };
}

function buildMarkdown(payload) {
  const L = [];
  const name = (payload.character && payload.character.name) || "艾莲";
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

function dialogOpts(win, opts) {
  return win ? [win, opts] : [opts];
}

async function exportChats({ store, character, dialog, getWindow, app, conversationId, filePath: forcedPath }) {
  const all = store.list();
  const threads = conversationId ? all.filter((t) => t.id === conversationId) : all;
  if (!threads.length) throw Error("还没有可以导出的聊天记录。");

  const payload = buildPayload(store, threads, character);
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `${((character && character.name) || "艾莲").replace(/[\\/:*?"<>|]/g, "")}-聊天记录-${stamp}`;
  // 默认导出到软件目录下的「导出」文件夹。这个位置一定可写，
  // 而系统的桌面/文档在受限环境里可能被拦（EPERM）。
  const dir = (() => {
    try {
      const d = path.join(process.resourcesPath, "..", "导出");
      fs.mkdirSync(d, { recursive: true });
      return d;
    } catch {}
    try {
      return app.getPath("downloads");
    } catch {
      return app.getPath("documents");
    }
  })();

  let target = typeof forcedPath === "string" && forcedPath ? forcedPath : "";
  if (!target) {
    const r = await dialog.showSaveDialog(
      ...dialogOpts(getWindow && getWindow(), {
        title: "导出聊天记录",
        defaultPath: path.join(dir, base + ".json"),
        filters: [
          { name: "艾莲聊天记录（可重新导入）", extensions: ["json"] },
          { name: "Markdown 文本（仅供阅读）", extensions: ["md"] },
        ],
      })
    );
    if (!r || r.canceled || !r.filePath) return null;
    target = r.filePath;
  }

  const isMd = path.extname(target).toLowerCase() === ".md";
  const body = isMd ? buildMarkdown(payload) : JSON.stringify(payload, null, 2);
  let saved = target;
  try {
    fs.writeFileSync(target, body, "utf8");
  } catch (e) {
    const code = e && e.code;
    console.error("[chat-io] write failed", target, code, e && e.message);
    if (code === "EPERM" || code === "EACCES" || code === "EROFS") {
      // 目标位置被系统拦住了，改存到软件目录下，保证导出不失败。
      const alt = path.join(dir, path.basename(target));
      try {
        fs.writeFileSync(alt, body, "utf8");
        saved = alt;
      } catch (e2) {
        throw Error(`无法写入 ${target}，换到软件目录也失败：${(e2 && e2.message) || e2}`);
      }
    } else {
      throw Error(`无法写入这个位置：${(e && e.message) || "未知原因"}。请换一个文件夹再试。`);
    }
  }

  return {
    path: saved,
    fallback: saved !== target,
    format: isMd ? "md" : "json",
    conversations: payload.conversations.length,
    messages: payload.conversations.reduce((n, c) => n + (c.messages || []).length, 0),
  };
}

// 能导入的三种扩展名，统一放在一个对话框里选，选完再按后缀分派：
//   .json / .ellenchat —— 电脑端「导出」得到的聊天记录
//   .ellenpack         —— 手机端「资料备份 → 导出聊天资料」得到的资料文件
const IMPORT_FILTERS = [
  { name: "艾莲聊天记录 / 手机资料文件", extensions: ["json", "ellenchat", "ellenpack"] },
];

// 只弹框选文件，不读内容。返回路径或 null（取消）。
async function pickImportFile({ dialog, getWindow }) {
  const r = await dialog.showOpenDialog(
    ...dialogOpts(getWindow && getWindow(), {
      title: "导入聊天记录",
      properties: ["openFile"],
      filters: IMPORT_FILTERS,
    })
  );
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  return r.filePaths[0];
}

// 路径已知时直接读并落库（不弹框）。
function importChatFile({ store, filePath }) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw Error("请选择一个聊天记录文件。");
  if (stat.size > MAX_IMPORT) throw Error("文件太大，最多 64 MB。");

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
  } catch (e) {
    if (e && e.code === "ERR_ENCODING_INVALID_ENCODED_DATA") throw Error("这个文件不是有效的 UTF-8 文本。");
    throw e;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Error("这个文件不是艾莲导出的聊天记录（JSON 解析失败）。");
  }
  return applyImport(store, data);
}

async function importChats({ store, dialog, getWindow }) {
  const file = await pickImportFile({ dialog, getWindow });
  if (!file) return null;
  return importChatFile({ store, filePath: file });
}

// 纯写入逻辑，不碰文件与对话框，方便单独测试。
function applyImport(store, data) {
  if (!data || data.format !== FORMAT) throw Error("这不是艾莲导出的聊天记录文件。");
  if (data.version !== VERSION) throw Error(`聊天记录版本不支持：${data.version}。`);
  if (!Array.isArray(data.conversations) || !data.conversations.length) throw Error("文件里没有聊天记录。");

  const result = { conversations: 0, messages: 0, skipped: 0, repeated: 0, ids: [] };

  // 先把库里已有的聊天做成指纹集合。同一个包第二次导入时整段内容一致，
  // 直接跳过，不再新建一段一模一样的聊天（以前是每导一次多一份）。
  const seen = new Set();
  try {
    for (const t of store.list()) {
      seen.add(conversationFingerprint(t.title, store.messages(t.id)));
    }
  } catch (e) {
    console.error("[chat-io] 读取已有聊天失败，本次不做重复检查", e && e.message);
  }

  for (const c of data.conversations) {
    const title = safeTitle(c && c.title, "导入的聊天");
    const msgs = Array.isArray(c && c.messages) ? c.messages : [];
    const fingerprint = conversationFingerprint(title, msgs);
    if (seen.has(fingerprint)) {
      result.repeated += 1;
      continue;
    }
    seen.add(fingerprint);

    const made = store.createConversation(title);
    result.conversations += 1;
    result.ids.push(made.id);
    for (const m of msgs) {
      if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") {
        result.skipped += 1;
        continue;
      }
      store.put(made.id, {
        id: randomUUID(),
        role: m.role,
        text: m.text,
        status: "completed",
        createdAt: typeof m.createdAt === "string" && m.createdAt ? m.createdAt : new Date().toISOString(),
        origin: m.origin,
        stickerId: m.stickerId,
        replyParts: m.replyParts,
        usage: m.usage,
      });
      result.messages += 1;
    }
  }

  if (!result.messages) {
    if (result.repeated) throw Error("这段聊天已经导入过了，这次没有新增内容。");
    throw Error("文件里的聊天记录是空的，没有导入任何内容。");
  }
  return result;
}

module.exports = {
  exportChats,
  importChats,
  importChatFile,
  pickImportFile,
  IMPORT_FILTERS,
  applyImport,
  buildPayload,
  buildMarkdown,
  portableMessage,
  conversationFingerprint,
  FORMAT,
  VERSION,
};
