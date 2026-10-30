"use strict";
// 主动消息的节奏参数。
// v3 起不再用「3-6 小时随机」决定开口时间：dueAt 只表示「最早可以说话时刻」，
// 真正的时机交给 proactive-gate.cjs 在本机零成本判定。
//
// 档位表（PRESETS / PRESET_NAMES / DEFAULT_PRESET / presetOf / isPreset）唯一事实源在
// proactive-gate.cjs，这里只转出，避免两份参数各改一半。
const gate = require("./proactive-gate.cjs");

const MINUTE = 6e4,
  SCHEDULE_VERSION = 3,
  fraction = (t) => Math.max(0, Math.min(1, t())),
  PRESETS = gate.PRESETS,
  PRESET_NAMES = gate.PRESET_NAMES,
  DEFAULT_PRESET = gate.DEFAULT_PRESET,
  presetOf = gate.presetOf,
  isPreset = gate.isPreset;

/** 检查间隔：本地 gate 每分钟跑一次（不花钱），30 分钟是走模型的最低间隔 */
function checkDelay(t) {
  return 6e4 * (t ? 1 : 30);
}

/** 两次主动之间的最小间隔（已被档位 minGapMs 取代，保留导出给旧调用方） */
function contactGap(t) {
  return 6e4 * (t ? 1 : 180);
}

/**
 * 最早可说话时刻：刚聊完先安静 30 分钟，之后每次 tick 由 gate 决定。
 * 不再是 180-360 分钟随机。
 */
function initialDelay(t) {
  return t ? 6e4 : 30 * MINUTE;
}

/** 补发间隔 45-90 分钟（原 60-120） */
function followupDelay(t, a = Math.random) {
  return t ? 6e4 : (45 + 45 * fraction(a)) * MINUTE;
}

/**
 * 补发次数由档位决定：安静 0 / 标准 2 / 黏人 2。
 * 标准档 2 次 = 首轮没回 → 补发一次 → 还没回 → 再试一次（换角度），
 * 之后当天不再追（日上限 4 组还剩 1 组留给别的话题）。
 */
function followupLimit(preset) {
  return presetOf(preset).followups;
}

module.exports = {
  TEST_MODE: !1,
  SCHEDULE_VERSION: 3,
  PRESETS: PRESETS,
  PRESET_NAMES: PRESET_NAMES,
  DEFAULT_PRESET: DEFAULT_PRESET,
  presetOf: presetOf,
  isPreset: isPreset,
  checkDelay: checkDelay,
  contactGap: contactGap,
  initialDelay: initialDelay,
  followupDelay: followupDelay,
  followupLimit: followupLimit
};
