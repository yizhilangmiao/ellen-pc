"use strict";
// 话题台账：她记着你提过的事，到点回来问一句。
//
// 存的不是"关怀语气"，是事实：你说了什么（原话片段）、什么时候该问。
// 设计要点：
// - 不新增模型调用，完全复用 assess() 那一次返回里的 threads / threadOps
// - 台账坏掉不能影响聊天：任何解析/写盘失败都退回空台账，绝不抛
// - 同一件事最多问两次，两次之间至少隔 12 小时；第三次必须你主动提起
//   （"被记着"和"被催"的差别全在这条上）
const fs = require("node:fs");
const path = require("node:path");

const KINDS = ["promise", "plan", "unfinished"];
const STATUSES = ["open", "done", "dropped"];
const MAX_THREADS = 20;
const MAX_TOPIC = 60;
const MAX_QUOTE = 40;
const MAX_ID = 24;
const MAX_AHEAD_MS = 14 * 864e5; // 十四天以后的事现在记没意义
const REVISIT_GAP_MS = 12 * 36e5; // 同一件事两次回访最少隔 12 小时
const MAX_VISITS = 2; // 同一件事最多主动问两次
const VERSION = 1;

const trim = (value, limit) => String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);

/** 一条话题能不能进台账。不合法返回 null，调用方直接丢。 */
function sanitizeThread(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const id = trim(raw.id, MAX_ID);
  const topic = trim(raw.topic, MAX_TOPIC);
  if (!id || !topic) return null;
  const kind = KINDS.includes(raw.kind) ? raw.kind : "unfinished";
  const dueAt = Date.parse(raw.dueAt);
  if (!Number.isFinite(dueAt)) return null;
  if (dueAt - now > MAX_AHEAD_MS) return null;
  return {
    id,
    topic,
    quote: trim(raw.quote, MAX_QUOTE),
    kind,
    dueAt: new Date(dueAt).toISOString(),
    status: STATUSES.includes(raw.status) ? raw.status : "open"
  };
}

/** 状态变更：只认做得成的。 */
function sanitizeOps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const op of raw) {
    if (!op || typeof op !== "object") continue;
    const id = trim(op.id, MAX_ID);
    if (!id || !STATUSES.includes(op.status)) continue;
    out.push({ id, status: op.status });
  }
  return out;
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

class OpenThreads {
  constructor({ file = null, clock = () => Date.now() } = {}) {
    this.file = file;
    this.clock = clock;
    this.cache = null;
  }

  /** 台账内容。读坏了退回空台账，不抛。 */
  data() {
    if (this.cache) return this.cache;
    const raw = this.file ? readJson(this.file) : null;
    const threads = Array.isArray(raw?.threads) ? raw.threads.filter((t) => t && typeof t === "object" && t.id && t.topic) : [];
    this.cache = { version: VERSION, threads };
    return this.cache;
  }

  save() {
    if (!this.file) return true;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.cache), "utf8");
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      return false; // 写不进去也不影响这次对话，下次照样能读旧台账
    }
  }

  list() {
    return this.data().threads.slice();
  }

  /** 该不该主动问、该问哪一条。没有到期的一律返回 null——不提前问，避免变成催。 */
  pick(now = this.clock()) {
    const due = this.data()
      .threads.filter((t) => t.status === "open" && (t.visits || 0) < MAX_VISITS)
      .filter((t) => {
        const at = Date.parse(t.dueAt);
        return Number.isFinite(at) && at <= now;
      })
      .filter((t) => {
        const last = Date.parse(t.lastVisitedAt);
        return !Number.isFinite(last) || now - last >= REVISIT_GAP_MS;
      })
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    return due[0] || null;
  }

  /** 本地打分用：几件事到期了。一条 +2，最多 +4——台账能加分，但不能单靠它就把闸推开。 */
  pressure(now = this.clock()) {
    const n = this.data().threads.filter((t) => {
      if (t.status !== "open" || (t.visits || 0) >= MAX_VISITS) return false;
      const at = Date.parse(t.dueAt);
      return Number.isFinite(at) && at <= now;
    }).length;
    return Math.min(4, n * 2);
  }

  /** 给模型看的摘要。只喂还没了结的，最多六条，别把 prompt 撑大。 */
  summary(now = this.clock(), limit = 6) {
    return this.data()
      .threads.filter((t) => t.status === "open")
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))
      .slice(0, limit)
      .map((t) => ({
        id: t.id,
        topic: t.topic,
        quote: t.quote || "",
        kind: t.kind,
        dueAt: t.dueAt,
        asked: t.visits || 0,
        overdue: Date.parse(t.dueAt) <= now
      }));
  }

  /** 合并模型这次返回的 threads / threadOps。返回 {added, closed}。 */
  apply(threads, ops, now = this.clock()) {
    const data = this.data();
    const byId = new Map(data.threads.map((t) => [t.id, t]));
    let added = 0;
    let closed = 0;

    const incoming = Array.isArray(threads) ? threads : [];
    for (const raw of incoming) {
      const next = sanitizeThread(raw, now);
      if (!next) continue;
      const prev = byId.get(next.id);
      if (prev) {
        // 同一件事再次被提到：只更新描述和截止时间，不重置已问次数（否则能无限追问）
        prev.topic = next.topic;
        prev.quote = next.quote || prev.quote;
        prev.kind = next.kind;
        prev.dueAt = next.dueAt;
        if (next.status === "open") prev.status = "open";
        continue;
      }
      byId.set(next.id, { ...next, visits: 0, lastVisitedAt: null, createdAt: new Date(now).toISOString() });
      added += 1;
    }

    for (const op of sanitizeOps(ops)) {
      const target = byId.get(op.id);
      if (!target) continue;
      if (target.status !== op.status) {
        target.status = op.status;
        if (op.status !== "open") closed += 1;
      }
    }

    // 上限：超了先淘汰最早到期的已了结项，再淘汰最早到期的 open 项
    let all = [...byId.values()];
    if (all.length > MAX_THREADS) {
      all.sort((a, b) => {
        const done = (t) => (t.status === "open" ? 1 : 0);
        if (done(a) !== done(b)) return done(a) - done(b);
        return Date.parse(a.dueAt) - Date.parse(b.dueAt);
      });
      all = all.slice(all.length - MAX_THREADS);
    }
    data.threads = all;
    this.save();
    return { added, closed };
  }

  /** 记一次回访。发送成功且问的是台账里那一件时才调。 */
  visit(id, now = this.clock()) {
    const target = this.data().threads.find((t) => t.id === id);
    if (!target) return false;
    target.visits = (target.visits || 0) + 1;
    target.lastVisitedAt = new Date(now).toISOString();
    // 到达上限后不再改 status：事件本身还没了结，只是她不再主动提
    this.save();
    return true;
  }
}

function createOpenThreads(options) {
  return new OpenThreads(options);
}

module.exports = {
  OpenThreads,
  createOpenThreads,
  sanitizeThread,
  sanitizeOps,
  KINDS,
  STATUSES,
  MAX_THREADS,
  MAX_TOPIC,
  MAX_QUOTE,
  MAX_AHEAD_MS,
  REVISIT_GAP_MS,
  MAX_VISITS
};
