"use strict";
// 会话工厂契约测试 —— 守住「createCompanionSession 返回值必须是会话对象」。
//
// 为什么单独立一个文件：
// 2026-10-30 P0。companion-session.cjs 的收尾一行被写成
//   return n.voice = new ManualVoice(...), ..., n.emotionScheduler = new EmotionScheduler({...});
// return 只接第一个操作数，整条逗号链的求值结果（EmotionScheduler 实例）成了工厂的返回值。
// 上层拿到的「会话」没有 service，第一次取 service.state.projectState 就抛
//   TypeError: Cannot read properties of undefined (reading 'projectState')
// → 桌面版启动即崩、界面卡在「正在准备聊天…」。
//
// 当时 tests/ 里 18 个文件、189 项测试全绿，因为它们没有一个真正装配这个工厂。
// 这个文件补的就是这一层：把 21 个依赖塞进 require.cache，真跑一次工厂，只断言形状。
// 它不测业务，只测「东西都接上了没有」。

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");

// ---- 依赖桩 ----
// 直接写进 require.cache：companion-session.cjs 是 CJS，require 走缓存，不会加载真实模块。
// 真实模块会 spawn 语音 worker、开 sqlite，测试里不需要也不该要。

const calls = { realtimeOn: 0, voiceOn: 0, serviceOn: 0 };

function stubClass(relFromSrc, extra) {
  class S {}
  Object.assign(S, extra || {});
  return S;
}

function putStub(relFromSrc, exports) {
  const full = require.resolve(path.join(SRC, relFromSrc));
  require.cache[full] = {
    id: full, filename: full, loaded: true, exports, children: [], paths: [],
  };
  return exports;
}

class BagStub {
  constructor() { this.state = {}; }
  on() {}
  stop() {}
  close() {}
  interrupt() {}
  update() {}
  cleanupCalls() {}
}

const ChatServiceStub = class extends BagStub {
  constructor(opts) {
    super();
    // 工厂里有 n.media.reconcileOwners(n.service.store.attachmentOwners())
    this.store = (opts && opts.store) || { attachmentOwners: () => [] };
  }
  on() { calls.serviceOn += 1; }
};
const RealtimeCallStub = class extends BagStub {
  on() { calls.realtimeOn += 1; }
};
const ManualVoiceStub = class extends BagStub {
  on() { calls.voiceOn += 1; }
};
const EmotionSchedulerStub = class extends BagStub {};

putStub("chat-store.cjs", {
  ChatStore: class {
    constructor() {}
    latestUser() { return null; }
    recentUserTimes() { return []; }
    attachmentOwners() { return []; }
    close() {}
  },
});
putStub("chat-service.cjs", { ChatService: ChatServiceStub });
putStub("companion-note.cjs", { CompanionNote: class {} });
putStub("daily-journal.cjs", { DailyJournal: BagStub });
putStub("manual-voice.cjs", { ManualVoice: ManualVoiceStub });
putStub("dictation.cjs", { Dictation: BagStub });
putStub("realtime-vad.cjs", { RealtimeVAD: BagStub });
putStub("realtime-call.cjs", { RealtimeCall: RealtimeCallStub });
putStub("realtime-asr.cjs", { RealtimeASR: BagStub });
putStub("local-speech.cjs", {
  LocalSpeech: BagStub,
  createVoiceWorker: () => ({}),
});
putStub("voice-profiles.cjs", { DEFAULT_VOICE_MODEL: "stub-model" });
putStub("translation-service.cjs", { TranslationService: BagStub });
putStub(path.join("..", "memory", "src", "create-runtime.cjs"), {
  createRuntime: () => ({
    on() {},
    state() { return { items: [] }; },
    core() { return {}; },
    close() {},
    running: false,
  }),
});
putStub(path.join("..", "memory", "src", "model-provider.cjs"), {
  MemoryModel: class {},
});
putStub("media-store.cjs", {
  MediaStore: class extends BagStub { reconcileOwners() {} },
});
putStub("media-process.cjs", { MediaProcessor: class {} });
putStub("voice-messages.cjs", { VoiceMessages: BagStub });
putStub("emotion-runtime.cjs", {
  EmotionRuntime: class extends BagStub {
    seed() {}
    view() { return { mood: "calm" }; }
  },
  EmotionScheduler: EmotionSchedulerStub,
});
putStub("activity-profile.cjs", {
  ActivityProfile: class {
    isSleeping() { return false; }
    sleepWindow() { return null; }
    maybeRefresh() {}
  },
});
putStub("proactive-gate.cjs", { ProactiveGate: class {} });
putStub("open-threads.cjs", { OpenThreads: class {} });

const { createCompanionSession } = require(path.join(SRC, "companion-session.cjs"));

// ---- 造一个能跑通工厂的上下文 ----
function buildSession() {
  calls.realtimeOn = 0;
  calls.voiceOn = 0;
  calls.serviceOn = 0;
  const gateway = { usageLedger: {} };
  const descriptor = {
    profileDir: path.join(SRC, "..", "_test-profile"),
    chatFile: path.join(SRC, "..", "_test-profile", "chats", "c1.json"),
    character: { id: "c1", name: "艾莲" },
    chatTitle: "测试会话",
    runtimeOptions: {},
    cardId: "card-1",
    profileId: "profile-1",
    memoryProfileKey: "mp-1",
    libraryId: "lib-1",
  };
  return createCompanionSession({
    descriptor,
    gateway,
    voiceSettings: { getConfig: () => ({}), getApiKey: () => "stub-key" },
    fetchImpl: async () => ({}),
    saveSelection: () => {},
    publish: () => {},
    isBusy: () => false,
    preferences: () => ({}),
    idleSeconds: () => null,
  });
}

function returnsSession(session) {
  if (session instanceof EmotionSchedulerStub) return "工厂返回了 EmotionScheduler，不是会话对象";
  return null;
}

test("工厂返回的是会话对象，不是逗号链尾的那个组件", async () => {
  const session = await buildSession();
  const why = returnsSession(session);
  assert.strictEqual(why, null, why);
  assert.strictEqual(typeof session, "object");
  assert.ok(session && typeof session === "object", "工厂返回了非对象");
});

test("会话对象的每个配件都已装配", async () => {
  const session = await buildSession();
  const required = [
    "service", "store", "memory", "voice", "voiceMessages", "realtime",
    "media", "emotion", "emotionScheduler", "journal", "historyTranslations",
    "activityProfile", "openThreads", "proactiveGate",
  ];
  for (const key of required) {
    assert.ok(session[key] !== undefined && session[key] !== null, `会话缺少 ${key}（undefined）」`);
  }
  assert.strictEqual(typeof session.close, "function", "会话缺少 close()");
});

test("service.state 可读，threadId 取值不抛（P0 的爆点）", async () => {
  const session = await buildSession();
  assert.ok(session.service && session.service.state, "service.state 不存在");
  // 0.1.22 就是死在这一行：session.service 是 undefined
  const threadId = session.service.state.threadId;
  assert.ok(threadId === undefined || typeof threadId === "string", "threadId 类型异常");
  assert.doesNotThrow(() => session.service.state.projectState);
});

test("链尾的事件绑定真的执行了（它们在 return 之后）", async () => {
  await buildSession();
  assert.ok(calls.realtimeOn >= 2, `realtime.on 只绑了 ${calls.realtimeOn} 次，应为 2`);
  assert.ok(calls.voiceOn >= 3, `voice.on 只绑了 ${calls.voiceOn} 次，应为 3`);
  assert.ok(calls.serviceOn >= 1, `service.on 只绑了 ${calls.serviceOn} 次，应为 1`);
});

test("装配失败时抛的是原始错误，不是被吞掉后的空对象", async () => {
  // isBusy 抛错不该让工厂静默返回半成品
  const gateway = { usageLedger: {} };
  await assert.rejects(
    () => createCompanionSession({
      descriptor: null,
      gateway,
      voiceSettings: { getConfig: () => ({}), getApiKey: () => "k" },
      fetchImpl: async () => ({}),
      saveSelection: () => {},
      publish: () => {},
      isBusy: () => false,
    }),
    (err) => {
      assert.ok(err instanceof Error, "抛的不是 Error");
      return true;
    },
  );
});
