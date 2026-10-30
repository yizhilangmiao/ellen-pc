"use strict";

/**
 * 主动消息第一道闸：纯本地、零成本。
 * 目的：把「现在到底该不该花一次模型调用」在这台机器上先判掉，
 * 不发就只写一行日志，绝不请求模型。
 */

const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 864e5;

// 三档：日上限按「组」算（一组 1-2 条消息），补发计入日上限
const PRESETS = {
  quiet: { name: "quiet", label: "安静", dailyGroups: 1, maxPerGroup: 1, followups: 0, minGapMs: 8 * 36e5, threshold: 6 },
  standard: { name: "standard", label: "标准", dailyGroups: 4, maxPerGroup: 2, followups: 2, minGapMs: 2.5 * 36e5, threshold: 4 },
  clingy: { name: "clingy", label: "黏人", dailyGroups: 6, maxPerGroup: 3, followups: 2, minGapMs: 1.5 * 36e5, threshold: 2 }
};

const PRESET_NAMES = ["quiet", "standard", "clingy"];
const DEFAULT_PRESET = "standard";

const IDLE_LIMIT_SECONDS = 900; // 15 分钟没动键盘鼠标 = 人不在
const RETURN_WINDOW_MS = 6e4; // 1 分钟内回来 = 刚回来
const JUST_TALKED_MS = 30 * 6e4; // 刚聊完 30 分钟内不插嘴
const DEEP_NIGHT_MINS = 90; // 睡前 90 分钟算深夜：先问一句事，别一上来就劝睡

function presetOf(name) {
  return PRESETS[PRESET_NAMES.includes(name) ? name : DEFAULT_PRESET];
}

function isPreset(name) {
  return PRESET_NAMES.includes(name);
}

/** 睡前窗口：[sleepStart-90, sleepStart)。跨夜时环形处理。 */
function deepNightAt(now, sleepStart) {
  if (!Number.isFinite(sleepStart)) return false;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const from = (sleepStart - DEEP_NIGHT_MINS + 1440) % 1440;
  if (from < sleepStart) return mins >= from && mins < sleepStart;
  return mins >= from || mins < sleepStart;
}

function localDateKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseTime(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * 纯函数判定，方便单测。
 * @returns {{allow:boolean, score:number, reason:string, preset:string, signals:string[]}}
 */
function evaluate(context = {}) {
  const {
    now = Date.now(),
    preset = DEFAULT_PRESET,
    sleeping = false,
    idleSeconds = null,
    previousIdleSeconds = null,
    lastUserAt = null,
    lastProactiveAt = null,
    groupsToday = 0,
    unanswered = false,
    threadScore = 0,
    deepNight = false,
    sleepStart = null,
    returnedUsedToday = false,
    idleLimitSeconds = IDLE_LIMIT_SECONDS
  } = context;

  const p = presetOf(preset);
  const signals = [];
  let nightFlag = deepNight === true || deepNightAt(now, sleepStart);
  const result = (allow, score, reason) => ({
    allow,
    score,
    reason,
    preset: p.name,
    deepNight: nightFlag,
    signals: signals.slice()
  });

  if (sleeping) return result(false, 0, "sleeping");

  // 人不在电脑前：不自己对着空屋子说话
  const idle = Number.isFinite(idleSeconds) ? idleSeconds : null;
  if (idle !== null && idle >= idleLimitSeconds) return result(false, 0, "away");

  if (groupsToday >= p.dailyGroups) return result(false, 0, "daily-limit");

  const lastProactive = parseTime(lastProactiveAt);
  if (lastProactive !== null && now - lastProactive < p.minGapMs) return result(false, 0, "min-gap");

  const lastUser = parseTime(lastUserAt);
  let score = 0;

  if (lastUser !== null) {
    const gap = now - lastUser;
    if (gap < JUST_TALKED_MS) return result(false, 0, "just-talked");
    if (gap >= 12 * 36e5) {
      score += 5;
      signals.push("gap-12h");
    } else if (gap >= 8 * 36e5) {
      score += 4;
      signals.push("gap-8h");
    } else if (gap >= 4 * 36e5) {
      score += 3;
      signals.push("gap-4h");
    }
  }

  // 刚坐下来（从离开回到在座）
  if (
    !returnedUsedToday &&
    Number.isFinite(previousIdleSeconds) &&
    previousIdleSeconds >= idleLimitSeconds &&
    idle !== null &&
    idle * 1000 < RETURN_WINDOW_MS
  ) {
    score += 3;
    signals.push("returned");
  }

  if (Number.isFinite(threadScore) && threadScore > 0) {
    score += threadScore;
    signals.push(`thread+${threadScore}`);
  }

  nightFlag = deepNight === true || deepNightAt(now, sleepStart);
  if (nightFlag) {
    score += 1;
    signals.push("deep-night");
  }

  if (unanswered) {
    score -= 3;
    signals.push("unanswered");
  }

  if (groupsToday >= 2) {
    score -= 2;
    signals.push(`groups-${groupsToday}`);
  }

  const allow = score >= p.threshold;
  return result(allow, score, allow ? "scored" : "below-threshold");
}

class ProactiveGate {
  constructor({ file = null, logFile = null, clock = () => Date.now() } = {}) {
    this.file = file;
    this.logFile = logFile;
    this.clock = clock;
    this.data = { version: 1, date: null, groups: 0, previousIdleSeconds: null, returnedDate: null };
    this.load();
  }

  load() {
    if (!this.file) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || raw.version !== 1) return this.data;
      this.data = {
        version: 1,
        date: typeof raw.date === "string" ? raw.date : null,
        groups: Number.isInteger(raw.groups) && raw.groups >= 0 ? raw.groups : 0,
        previousIdleSeconds: Number.isFinite(raw.previousIdleSeconds) ? raw.previousIdleSeconds : null,
        returnedDate: typeof raw.returnedDate === "string" ? raw.returnedDate : null
      };
    } catch {
      // 读不到就当前一天 0 组，不阻断
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

  /** 跨天清零 */
  groupsToday(now = this.clock()) {
    const today = localDateKey(now);
    if (this.data.date !== today) {
      this.data = { ...this.data, date: today, groups: 0, returnedDate: null };
      this.save();
    }
    return this.data.groups;
  }

  evaluate(context = {}) {
    const now = Number.isFinite(context.now) ? context.now : this.clock();
    const groups = this.groupsToday(now);
    const decision = evaluate({
      ...context,
      now,
      groupsToday: groups,
      returnedUsedToday: this.data.returnedDate === localDateKey(now),
      previousIdleSeconds: Number.isFinite(context.previousIdleSeconds)
        ? context.previousIdleSeconds
        : this.data.previousIdleSeconds
    });
    this.lastDecision = decision;

    if (Number.isFinite(context.idleSeconds)) {
      this.data = { ...this.data, previousIdleSeconds: context.idleSeconds };
    }
    this.save();
    this.writeLog(decision, now);
    return decision;
  }

  /** 真发出去之后调一次。决策里含 returned 才消耗当天那一次"你回来了"。 */
  commit(now = this.clock(), decision = this.lastDecision) {
    const groups = this.groupsToday(now);
    const returned = !!(decision && Array.isArray(decision.signals) && decision.signals.includes("returned"));
    this.data = {
      ...this.data,
      date: localDateKey(now),
      groups: groups + 1,
      returnedDate: returned ? localDateKey(now) : this.data.returnedDate
    };
    this.save();
    return this.data.groups;
  }

  writeLog(decision, now = this.clock()) {
    if (!this.logFile) return;
    // 每分钟判一次，同样的结论不重复刷日志：reason+score 不变就 10 分钟一条。
    // 放行一定写（那是真发生了的事）。
    const signature = `${decision.reason}:${decision.score}`;
    if (
      !decision.allow &&
      signature === this.data.lastLogSignature &&
      Number.isFinite(this.data.lastLogAt) &&
      now - this.data.lastLogAt < 6e5
    ) {
      return;
    }
    this.data = { ...this.data, lastLogSignature: signature, lastLogAt: now };
    const line = [
      new Date(now).toISOString(),
      decision.allow ? "ALLOW" : "SKIP",
      `score=${decision.score}`,
      `preset=${decision.preset}`,
      decision.reason,
      decision.signals.length ? decision.signals.join(",") : "-"
    ].join(" ");
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `${line}\n`);
    } catch {
      // 日志写不了不影响判断
    }
  }
}

function createProactiveGate(options) {
  return new ProactiveGate(options);
}

module.exports = {
  PRESETS,
  PRESET_NAMES,
  DEFAULT_PRESET,
  IDLE_LIMIT_SECONDS,
  JUST_TALKED_MS,
  DEEP_NIGHT_MINS,
  deepNightAt,
  presetOf,
  isPreset,
  evaluate,
  localDateKey,
  createProactiveGate,
  ProactiveGate
};
