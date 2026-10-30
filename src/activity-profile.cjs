"use strict";

/**
 * 作息学习：从聊天记录的时间戳学出「用户一天里什么时候在电脑前、什么时候在睡」。
 * 只在本机计算，不上传任何东西。
 */

const fs = require("node:fs");
const path = require("node:path");

const HOURS = 24;
const DAY_MS = 864e5;
const RECOMPUTE_MS = 6 * 36e5; // 每 6 小时重算一次
const WINDOW_DAYS = 7; // 只看最近 7 天
const RECENT_DAYS = 3; // 最近 3 天加权
const RECENT_WEIGHT = 3;
const OLD_WEIGHT = 1;
const COLD_MIN_SAMPLES = 30; // 少于这个数就退回冷启动曲线
const ACTIVE_THRESHOLD = 0.35;
const SLEEP_THRESHOLD = 0.15;
const SLEEP_MIN_HOURS = 4; // 连续 4 小时不活跃才算睡觉
const MAX_SLEEP_HOURS = 10; // 一天睡超过 10 小时不合常理，多出来的低活跃段是「不在电脑前」

// 冷启动：9-22 时 0.8，1-8 时 0.1，23 点与 0 点 0.2。
// 23/0 点不压到 0.1 是有意的：那正是「睡前」窗口，她得能说话问一句再劝睡；
// 真正静默的是 01:00-09:00。（当前真机样本仅 8 条，一定走这条）
const COLD_START = [
  0.2, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
  0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8,
  0.2
];

const DEFAULT_SLEEP = { start: 60, end: 540 }; // 01:00 - 09:00

/** "01:00" → 60；非法返回 null */
function parseClock(text) {
  if (typeof text !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 60 → "01:00" */
function formatClock(minute) {
  const n = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

/** 把 {start:"01:00",end:"09:00"} 规整成分钟数；非法返回 null */
function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start == null || end == null) return null;
  if (start === end) return null;
  return { start, end };
}

/** 分钟数是否落在（可跨夜的）区间里 */
function inWindow(minute, window) {
  if (!window) return false;
  const { start, end } = window;
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/**
 * 从小时曲线里找睡眠段：连续 >= 4 小时 value < 0.15 的最长环形区间。
 * 找不到返回 null。
 */
function detectSleep(curve) {
  if (!Array.isArray(curve) || curve.length !== HOURS) return null;
  const low = curve.map((v) => v < SLEEP_THRESHOLD);
  const anchor = low.findIndex((v) => !v);
  if (anchor < 0) return null; // 全时段都很活跃，推不出睡觉时间
  let best = null;
  let runStart = -1;
  let runLen = 0;
  for (let k = 1; k <= HOURS; k += 1) {
    const h = (anchor + k) % HOURS;
    if (low[h]) {
      if (runLen === 0) runStart = h;
      runLen += 1;
    } else if (runLen > 0) {
      if (runLen >= SLEEP_MIN_HOURS && (!best || runLen > best.len)) {
        best = { start: runStart, len: runLen };
      }
      runLen = 0;
    }
  }
  if (runLen >= SLEEP_MIN_HOURS && (!best || runLen > best.len)) {
    best = { start: runStart, len: runLen };
  }
  if (!best) return null;
  // 白天整天不在电脑前的人，最长低活跃段会横跨整个白天（如 23:00-18:00，19 小时）。
  // 那不是睡觉，按睡觉处理会把白天全静音。裁到合理睡眠长度：留住段起点（入睡点在晚间活跃之后），
  // 向后只取到上限，多出来的白天交给「人不在电脑前」那条闸去判断。
  const len = Math.min(best.len, MAX_SLEEP_HOURS);
  return { start: best.start * 60, end: ((best.start + len) % HOURS) * 60 };
}

/** 某小时的活跃程度，0..1 */
function activityAt(ms, curve) {
  if (!Array.isArray(curve) || curve.length !== HOURS) return 0;
  return curve[new Date(ms).getHours()] ?? 0;
}

function isActiveAt(ms, curve, threshold = ACTIVE_THRESHOLD) {
  return activityAt(ms, curve) >= threshold;
}

/**
 * rows 可以是毫秒数、ISO 字符串，或带 at/createdAt 字段的对象。
 * 返回 {curve, samples, cold}
 */
function buildCurve(rows, now = Date.now()) {
  const buckets = new Array(HOURS).fill(0);
  let samples = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at =
      typeof row === "number"
        ? row
        : Date.parse(row && typeof row === "object" ? row.at ?? row.createdAt ?? row.time : row);
    if (!Number.isFinite(at)) continue;
    const age = now - at;
    if (age < 0 || age > WINDOW_DAYS * DAY_MS) continue;
    buckets[new Date(at).getHours()] += age <= RECENT_DAYS * DAY_MS ? RECENT_WEIGHT : OLD_WEIGHT;
    samples += 1;
  }
  if (samples < COLD_MIN_SAMPLES) {
    return { curve: COLD_START.slice(), samples, cold: true };
  }
  const max = Math.max(...buckets);
  return {
    curve: max > 0 ? buckets.map((v) => v / max) : COLD_START.slice(),
    samples,
    cold: false
  };
}

class ActivityProfile {
  constructor({ file = null, clock = () => Date.now() } = {}) {
    this.file = file;
    this.clock = clock;
    this.data = {
      version: 1,
      computedAt: null,
      curve: COLD_START.slice(),
      samples: 0,
      cold: true,
      sleep: null
    };
    this.load();
  }

  load() {
    if (!this.file) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || raw.version !== 1 || !Array.isArray(raw.curve) || raw.curve.length !== HOURS) return this.data;
      if (raw.curve.some((v) => !Number.isFinite(v))) return this.data;
      this.data = {
        version: 1,
        computedAt: typeof raw.computedAt === "string" ? raw.computedAt : null,
        curve: raw.curve.slice(),
        samples: Number.isInteger(raw.samples) ? raw.samples : 0,
        cold: raw.cold !== false,
        sleep: normalizeWindow(raw.sleep)
      };
    } catch {
      // 读不到就用冷启动曲线，不阻断
    }
    return this.data;
  }

  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
      return true;
    } catch {
      return false;
    }
  }

  refresh(rows, now = this.clock()) {
    const built = buildCurve(rows, now);
    this.data = {
      version: 1,
      computedAt: new Date(now).toISOString(),
      curve: built.curve,
      samples: built.samples,
      cold: built.cold,
      sleep: detectSleep(built.curve)
    };
    this.save();
    return this.data;
  }

  /** 到 6 小时了才重算，否则原样返回 */
  maybeRefresh(rows, now = this.clock()) {
    const at = this.data.computedAt ? Date.parse(this.data.computedAt) : 0;
    if (at && now - at >= 0 && now - at < RECOMPUTE_MS) return this.data;
    return this.refresh(rows, now);
  }

  curve() {
    return this.data.curve.slice();
  }

  /** 手改优先于推断；都没有就用 01:00-09:00 */
  sleepWindow(override) {
    return normalizeWindow(override) || this.data.sleep || DEFAULT_SLEEP;
  }

  isSleeping(ms = this.clock(), override) {
    const window = this.sleepWindow(override);
    const d = new Date(ms);
    return inWindow(d.getHours() * 60 + d.getMinutes(), window);
  }

  isActive(ms = this.clock()) {
    return isActiveAt(ms, this.data.curve);
  }

  /** 夜里最后一个还活跃的小时，用来算「睡前 90 分钟」窗口 */
  sleepWindowText(override) {
    const w = this.sleepWindow(override);
    return { start: formatClock(w.start), end: formatClock(w.end) };
  }
}

function createActivityProfile(options) {
  return new ActivityProfile(options);
}

module.exports = {
  ActivityProfile,
  createActivityProfile,
  buildCurve,
  detectSleep,
  inWindow,
  parseClock,
  formatClock,
  normalizeWindow,
  activityAt,
  isActiveAt,
  COLD_START,
  DEFAULT_SLEEP,
  RECOMPUTE_MS,
  COLD_MIN_SAMPLES,
  ACTIVE_THRESHOLD,
  SLEEP_THRESHOLD,
  SLEEP_MIN_HOURS,
  MAX_SLEEP_HOURS
};
