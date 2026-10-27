# 艾莲 · 产品需求文档（PRD）

> 版本：0.2.5（源码基线 `5806c67`）
> 反推时间：2026-10-27
> 性质：**从现有代码反推**，不是理想设计稿。凡标 `[待确认]` 的，都是代码里读不出、需要 YG 亲口定的。
> 用法：这是后续开发的唯一依据。改功能先改这份文档，再改代码。

---

## 一、产品目标与定位

艾莲是一款 **只跑在用户自己电脑上的 AI 伴侣/角色陪伴应用**（Electron 单机应用）。

- 不是聊天工具，是**长期关系模拟器**：有情绪状态、有记忆、有关系进展、会随时间变化。
- 不是云服务：**数据全部留在本机**，没有账号体系、没有云端同步。
- 不是通用助手：角色资产（人设卡、世界设定、表达样本）决定她是谁，模型只是驱动她的引擎。

三件事构成护城河，缺一个就不成立：

| 支柱 | 机制 | 代码位置 |
|---|---|---|
| **记得住** | 原始事件不可变 + 记忆强度衰减 + 用户可纠正 | `memory/src/schema.sql` |
| **有温度** | 情绪状态机 + 关系阶段 + 主动发言 | `src/emotion-*.cjs`、`src/proactive-*.cjs` |
| **能听会说** | 实时语音通话 + 本地语音 + 声音克隆 | `src/realtime-*.cjs`、`src/minimax-*.cjs` |

---

## 二、使用场景

| 场景 | 用户动作 | 系统行为 |
|---|---|---|
| 日常闲聊 | 打字/语音输入 | 逐句流式回复、可选语音合成、表情与颜文字、情绪随之变化 |
| 语音通话 | 点通话 | 全双工实时语音（ASR→模型→TTS），常驻通话窗口，波形可视化 |
| 挂机陪伴 | 挂着窗口/桌面小挂件 | 按时间与情绪主动发起话题、桌面提醒、情境小挂件（游泳宠物） |
| 剧情模式 | 启动 `--story` | 剧本式互动：开场旁白、分幕推进、协议约束 |
| 回忆与纠正 | 打开回忆页 | 查看她记住了什么、纠正错误、决定哪些允许淡忘 |
| 每日手记 | 打开手记 | 自动汇总当天对话为日记，附用户原话溯源 |

---

## 三、运行形态与技术基线

### 3.1 目录与启动

```
E:\ailian\
├─ 艾莲电脑端\resources\app\   ← 源码真身（git 仓库根）
│  ├─ boot.dev.cjs             ← 开发入口（package.json 的 main）
│  ├─ boot.cjs                 ← 正式入口（含完整性校验 + 自动更新）
│  ├─ src\                     ← 日常陪伴模式（daily）
│  ├─ story\                   ← 剧情模式（story）
│  ├─ characters\              ← 角色资产（ellen / ellen-lover）
│  ├─ memory\src\              ← 记忆与关系子系统源码
│  ├─ runtime\                 ← Python/模型运行时（1.4GB，不入库）
│  └─ data\                    ← 用户数据（聊天库/配置/日志，不入库）
└─ 艾莲开发版\resources\app    ← **JUNCTION** 指向上面那个 app 目录（同一份文件）
```

- 双模式由命令行开关决定：`--story` → `story/story-main.cjs`，否则 `src/main.cjs`（`boot.dev.cjs:16`）
- `userData` 落在应用目录内 `data\app`，不写 `%LOCALAPPDATA%`（`boot.dev.cjs:21-23`）——为了 Chromium 的 GPU 缓存能建在可写盘上，否则界面掉帧
- 开发版跳过 1.6GB 完整性校验（`boot.dev.cjs:38`）、允许 `--inspect` 调试参数、异常直接弹栈

### 3.2 进程与通信

- 单主窗口 + 若干独立窗口（通话窗、桌面小挂件、截图、DLC 阅读器、激活页）
- IPC **只有两个通道**（`src/main.cjs`）：
  - `companion:invoke` —— 统一路由，前端发 `{action, payload}`，主进程分发给 `*-actions.cjs`
  - `companion:ui-health` —— 界面健康自检
- 前端通过 `preload.cjs` 暴露受限 API，不直接拿 `require`

### 3.3 技术选型（现状）

| 层 | 选择 | 说明 |
|---|---|---|
| 桌面 | Electron 44.4.1 | 主进程逻辑用 `.cjs`，前端用原生 JS（无框架） |
| 聊天库 | **`node:sqlite`（Node 24 内置）** | 无需原生编译，`chat-store.cjs` |
| 记忆库 | SQLite（`memory/src/*.sql`） | 独立库，按 owner×character 隔离 |
| 模型 | OpenAI 兼容 HTTP + SSE 流式 | 用户自填 base-url / api-key，不锁厂商 |
| 语音 | 本地 Python 运行时 + 云端 TTS/克隆 | `runtime/python`、`runtime/realtime` |
| 授权 | 离线机器码 Ed25519 | `release.json.bak`: `offline-machine-v1` |

---

## 四、页面结构与交互

### 4.1 主窗口（daily）

单页应用，`src/ui/index.html`（31.6KB，187 个具名区块）。自上而下五条带：

```
┌─ 标题栏 ────────────────────────────────────────────────┐
│ 角色名 · 页面标题      [设置][全屏][置顶][隐藏][关闭]      │
├─ 生活侧栏（可折叠）──────────────────────────────────────┤
│ 时钟 / 今天 / 问候语 / 里程碑（相处天数）/ 她写的便签     │
├─ 对话区 ────────────────────────────────────────────────┤
│ 消息流（文字·语音·贴纸·图片·通话记录）                     │
│ 情绪条（mood）：当前情绪 / 触发原因 / 变化时间 / 详情      │
│ 在场状态（presence）                                      │
│ 错误与重试 / Token 用量面板                               │
├─ 输入区 ────────────────────────────────────────────────┤
│ 上下文提示 / 输入框 / [语音][发送][停止] / 语音字幕        │
├─ 浮层 ──────────────────────────────────────────────────┤
│ 历史会话 ｜ 设置（通用·模型·声音·语音动作）｜ 角色管理 ｜ 世界书 │
│ 外观 ｜ 反馈 ｜ API 费用 ｜ 更新                            │
└─────────────────────────────────────────────────────────┘
```

### 4.2 其他窗口

| 窗口 | 文件 | 用途 |
|---|---|---|
| 通话窗 | `ellen-call-window.js` | 独立全屏/浮窗通话，波形 + 挂断 + 计时 |
| 桌面小挂件 | `desktop-mini.html` | 常驻桌面的迷你形态 |
| 桌面提醒 | `desktop-alert.html` | 主动消息的系统级弹窗 |
| 截图 | `screenshot.html` | 截屏送模型（可看屏幕） |
| 激活页 | `src/licensing/activation.html` | 输入激活码 |
| DLC 阅读器 | `src/licensing/dlc-reader.html` | 读取已购内容包 |
| 剧情模式 | `story/index.html` | 剧本式互动界面 |

### 4.3 交互原则（从实现反推）

1. **消息不可撤回地流式出现**：逐句回复（`sentence-reply.cjs` + `reply-pacer.cjs`），失败保留已收到的文字、不自动重发
2. **语音可选、可静音**：文字永远可读，语音失败降级为文字（"上次语音未生成完成，先显示文字"）
3. **一切可纠正**：情绪可纠、记忆可纠、关系评分可纠，纠正是新版本而非覆盖
4. **窗口行为有记忆**：置顶、隐藏、关闭行为（`close-behavior.cjs`）、挂件位置都持久化
5. **空闲检测**：长时间不说话会触发主动行为（`checkIdle`）

---

## 五、功能模块清单

### 5.1 对话与表达

| 模块 | 文件 | 用途 |
|---|---|---|
| 聊天服务 | `chat-service.cjs` / `chat-store.cjs` / `chat-io.cjs` | 请求编排、SQLite 落盘、记录导出导入 |
| 逐句回复 | `sentence-reply.cjs` / `reply-pacer.cjs` / `reply-layout.cjs` | 按句切分、按节奏推送、排版 |
| 表达意图 | `expression-intent.cjs` / `ui/expression-vector.js` | 决定这条回复带什么表情/动作 |
| 颜文字 | `kaomoji.cjs` + `characters/*/颜文字素材.json` | 颜文字素材库 |
| 语音消息 | `voice-messages.cjs` / `manual-voice.cjs` | 生成语音条、手动触发发音 |
| 口型同步 | `ui/lip-sync.js` | 播放语音时的嘴型/表情联动 |
| 贴纸 | `ui/stickers.js` / `ui/sticker-catalog.js` | 发贴纸、贴纸库 |
| 消息通知 | `ui/message-notifications.js` | 窗口不在前台时提醒 |
| 翻译 | `translation-service.cjs` / `ui/translation.js` | 外语内容翻译 |

### 5.2 情绪与关系

| 模块 | 文件 | 用途 |
|---|---|---|
| 情绪状态机 | `emotion-runtime.cjs` / `emotion-response.cjs` / `emotion-behavior.md` | 情绪的当前值、衰减、对回复的影响 |
| 情绪调度 | `emotion-schedule.cjs` | 按时间/事件驱动情绪变化 |
| 情绪交互 | `emotion-interaction.cjs` | 用户行为如何影响情绪 |
| 情绪提示词 | `emotion-prompt.md` | 注入模型的情绪描述 |
| 关系评分 | `memory/src/relationship-policy.cjs` / `relationship-store.cjs` | 关系维度打分与阶段判定 |
| 心情状态 | `memory/src/mood-state.cjs` | 短期心情（区别于长期情绪） |

### 5.3 记忆系统

分两层：**记忆库**（长期，独立 SQLite）+ **对话库**（原始消息，`chat-store`）。

数据模型（`memory/src/schema.sql`，全部 `STRICT` 表 + 不可变触发器）：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `store_info` | 库归属 | 单例，绑定 `owner_id` + `character_id` |
| `experiences` | 经历序列 | `(conversation_id, experience_key)` 唯一 |
| `source_events` | **原始事件（证据）** | `origin` ∈ text/voice_text/voice_transcript；**禁止 UPDATE**（触发器） |
| `memories` | 提炼出的记忆 | `kind` ∈ user_fact/shared_event；`base_strength` 0–1；`status` active/superseded 版本链；`auto_retained`/`user_retained`/`auto_suppressed` 三态 |
| `memory_sources` | 记忆↔原文溯源 | 多对多，保证每条记忆都能追到原话 |
| `decisions` | 决策审计 | `actor` ∈ auto/user；`action` ∈ classify/retain/release/supersede；`reason` 必填；**禁止 UPDATE** |

关系模型（`relationship-schema.sql`）：`relationship_state`（单例 + revision）、`relationship_events`（带 before/after 快照、policy、delta）、`relationship_corrections`（用户或模型纠正，同样不可变）。

**设计要义**：原文是证据，绝不覆盖；纠正产生新版本；每条记忆必须能追溯到 `source_events`。这是防幻觉的硬约束，不是可选优化。

用户侧入口（`memory-review.cjs` 的 action）：`overview` / `detail` / `correct` / `correctRelationship` / `retention`，记忆状态分 `retained`（保留）/ `dormant`（休眠）/ `ordinary`（普通）。允许用户选择"逐渐淡忘，原文保留"。

每日手记（`user-knowledge.cjs`）：把当天对话整理成"这一天的认识"，**必须带 `sourceIds`（用户原话 id），否则拒绝保存**（"这页认识缺少对应的用户原话，未保存"）。

### 5.4 语音与通话

| 模块 | 文件 | 用途 |
|---|---|---|
| 实时通话 | `realtime-call.cjs` / `ui/realtime-voice.js` | 全双工通话主控 |
| ASR | `realtime-asr.cjs` / `realtime-asr-worker.py` | 流式语音识别 |
| VAD | `realtime-vad.cjs` / `realtime-vad-worker.cjs` | 断句检测 |
| 本地语音 | `local-speech.cjs` / `dictation.cjs` / `dictation-worker.py` | 离线 TTS/听写 |
| 云端 TTS | `minimax-speech.cjs` / `minimax-regions.cjs` | 按区域选线路 |
| 声音克隆 | `minimax-clone.cjs` / `ui/manual-voice.js` | 音色复刻（设置里有克隆表单） |
| 语音配置 | `voice-profiles.cjs` / `voice-provider-settings.cjs` | 多套音色档案 |
| 通话记录 | `call-history.cjs` / `ui/call-history.js` | 历次通话留存 |
| 性能与用量 | `voice-latency.cjs` / `speech-usage.cjs` / `speech-performance.cjs` | 延迟监控、计费统计 |
| 失败引导 | `ui/voice-failure-guidance.js` | 语音失败时告诉用户怎么办 |

**发声有两条完全独立的链路，用户在「设置 → 声音」里选一条**：

| | 本地语音（GPT-SoVITS） | 云端语音（MiniMax） |
|---|---|---|
| 实现 | `local-speech.cjs` 用 `spawn` 起 Python 子进程，收 `pcm_s16le` 流（`audio-chunk` 事件） | `minimax-speech.cjs` HTTP 调 MiniMax，模型 `speech-2.8-hd` / `speech-2.8-turbo` |
| 算在哪 | 本机显卡/CPU | MiniMax 服务器（要说的文字会发出去） |
| 花钱 | 不花，只耗电 | 按用量计费（余额/额度/限流各有独立报错文案） |
| 音色 | 本机模型文件 | 平台音色，或自己克隆的（`minimax-clone.cjs` + `/v1/get_voice`） |
| 站点 | 无 | 分 `china` / `international`，各填各的密钥 |
| 情绪 | 无 | 7 种：happy / angry / relaxed / serious / jealous / tsundere / displeased |
| 失败表现 | "所选声音加载失败，请查看本地模型和运行环境" | "账户余额不足" / "额度已用完" / "请求过于频繁" 逐条对应 |

**已知硬编码风险**：`local-speech.cjs` 的 `localVoicePaths()` 把 Python 解释器写死为
`D:/AI-Local/新想法/GPT-SoVITS-v2ProPlus-20260921/.venv/Scripts/python.exe`。
该目录一旦改名/迁移/删掉，本地语音直接不可用（报"运行环境"）。见 11.2 待确认。

### 5.5 主动性

| 模块 | 文件 | 用途 |
|---|---|---|
| 主动上下文 | `proactive-context.cjs` / `proactive-topics.md` | 什么时机能主动说话、说什么 |
| 陪伴会话 | `companion-session.cjs` | 挂机会话的生命周期 |
| 陪伴卡片 | `companion-cards.cjs` / `companion-note.cjs` | 主动推送的卡片/便签 |
| 里程碑 | `ui/milestones.js` / `milestones-model.js` | 相处天数、纪念日 |
| 桌面提醒 | `desktop-alerts.cjs` / `ui/desktop-alert.js` | 系统级提醒 |
| 屏幕感知 | `screenshot.cjs` / `screenshot-geometry.cjs` | 截屏理解（需用户授权） |

### 5.6 角色与世界观

| 模块 | 文件 | 用途 |
|---|---|---|
| 角色卡 | `character-card-format.cjs` / `character-library.cjs` | 角色卡导入（格式校验、大小限制） |
| 世界书 | `worldbooks.cjs` / `ui/worldbook-manager.js` | 设定条目按关键词注入 |
| 角色隔离 | `memory/src/character-selection.cjs` | 每个角色独立记忆库 |
| 引导对话 | `dialogue-guidance.cjs` | 开场白与话题引导 |
| 用户画像 | `memory/src/customer-profile.cjs` / `user-knowledge.cjs` | 从对话中提炼用户信息 |

**现有角色资产**：`characters/ellen/`（艾莲，含核心档案 7.3KB、世界设定 24.6KB、表达样本 88.9KB、原作记忆 77.5KB、背景补充世界书 39.1KB、当轮接话 8.3KB）、`characters/ellen-lover/`（恋人线，核心卡 212.8KB + 核心卡.md 15.5KB + 颜文字素材 19.5KB + 当轮接话 30.8KB）。`active-card.json` 记录当前激活角色。

### 5.7 模型与计费

| 模块 | 文件 | 用途 |
|---|---|---|
| 模型网关 | `model-gateway.cjs` | OpenAI 兼容 + SSE 流式 + abort/timeout |
| 模型目录 | `model-catalog.cjs` | 可选模型清单 |
| 供应商设置 | `model-provider-settings.cjs` | base-url / api-key / 校验 / 移除 |
| 思考策略 | `ui/model-thinking-policy.js` | 何时带 thinking（推理模型） |
| 用量账本 | `model-usage-ledger.cjs` / `token-usage.cjs` / `api-usage-stats.cjs` | Token 与费用统计 |
| 请求经济 | `request-economy.cjs` | 请求节流/合并 |
| 费用面板 | `ui/api-cost.js` | 展示花了多少钱 |

**模型来源完全开放，不锁厂商**：供应商设置里填任意 OpenAI 兼容的 `base-url` + `api-key`（要求 HTTPS 或本机 localhost）；`ModelCatalog` 会调 `/v1/models` 拉列表，拉不到时（无列表权限 / 限流 / 填成官网页面）允许**手动填写模型 ID**。默认预填 DeepSeek 只是省事，不是限制。

### 5.8 外观与体验

`appearance-store.cjs` / `appearance-actions.cjs` / `ui/appearance.js`：背景图、主题、动效开关、界面音效、背景音乐。角色切换时外观按 `role` 隔离（"当前角色已切换，请重新打开外观面板"）。

其他：`window-pin.cjs`（置顶）、`window-presentation.cjs`（窗口形态）、`close-behavior.cjs`（关闭行为）、`background-music.cjs`、`ui/ellen-motion.js`（动效）、`ui/ellen-swim-pet.js`（桌面游泳宠物）、`ui/ellen-living-wallpaper.js`（动态壁纸）。

### 5.9 授权与 DLC

**授权**：离线机器码 + Ed25519 签名。文件 `license.ellen` + `clock.bin`，代码在 `src/licensing/`（含 `format.cjs` / `store.cjs` / `keys.cjs` / `activation` 页）。状态机：`perpetual` / `trial` / `EXPIRED` / `MISSING` / `DOWNGRADE` / `STORAGE` / `CLOCK`，每种都有面向用户的中文文案（如"试玩已结束。购买后输入永久激活码即可继续使用原来的聊天和记忆。"）。安卓端另有一套（`ELLENA1` 前缀 / `android-v1` / Ed25519 + 机器码 `ELA1-` / AndroidKeyStore），流程文档在 `E:\ailian\_临时\EllenLicense-激活校验流程.md`。

**DLC**：已实现但不启用。17 个 `dlc-*` 文件全在 `src/licensing/`，内容源是腾讯云 COS：`https://ellen-updates-1410769069.cos.ap-guangzhou.myqcloud.com/dlc/`（`dlc-config.cjs` 全文只有这一行 baseURL），独立窗口 `dlc.html` 不在主界面。
**YG 2026-10-27 决定：不做 DLC。** 后续应下线入口，代码可暂留。

### 5.10 系统保障

`startup-progress.cjs`（启动进度窗）、`startup-diagnostics.cjs`（启动诊断）、`shutdown.cjs`（退出清理）、`service-errors.cjs`（错误归一）、`ui/performance.js`（前端性能探针）、`ui/updates.js` + `src/updating/`（更新检查与安装）。

---

## 六、模块关系与数据流

```
用户输入（文字/语音）
   │
   ├─ 语音 → realtime-asr / vad → 文本
   ▼
chat-service（编排）
   ├─ 读记忆：memory-runtime → hybrid-recall（记忆+向量混合召回）
   ├─ 读关系：relationship-store（当前阶段与偏好）
   ├─ 读情绪：emotion-runtime（当前情绪值）
   ├─ 读世界书：worldbooks（关键词命中注入）
   ├─ 组装提示词：emotion-prompt.md + 角色核心卡 + 记忆片段
   ▼
model-gateway（SSE 流式）
   ▼
sentence-reply 逐句 → reply-pacer 控节奏
   ├─ expression-intent → 表情/颜文字/贴纸
   ├─ minimax-speech / local-speech → 语音（可选）
   ▼
写回两侧：
   ├─ chat-store（conversations / messages / 附属表）
   └─ memory-batch（异步提炼）→ memories + source_events + decisions
                                  └→ relationship-policy 更新关系
                                  └→ mood-state 更新心情
```

**关键约定**：记忆写入一律异步、可审计；任何纠正都进 `decisions` / `relationship_corrections`，不改历史行。

---

## 七、数据持久化与备份

### 7.1 落盘位置

| 数据 | 路径（相对 `app\`） | 格式 |
|---|---|---|
| **聊天记录** | `data\characters\<角色>\profiles\<profile>\conversations.sqlite` | SQLite |
| **记忆库** | `data\characters\<角色>\profiles\<profile>\memory\memory.sqlite` | SQLite |
| 记忆原文/关系 | 同上 `memory\` 目录下的 JSON（核心档案.md、关系状态.json、记忆规则.json…） | JSON / MD |
| 模型用量 | `data\app\model-usage.sqlite` | SQLite |
| 外观设置 | `data\appearance\<hash>\settings.json` | JSON |
| 角色库索引 | `data\character-library\library.json` | JSON |
| 模型配置 | `data\app\model-provider.json` | JSON |
| Chromium 缓存 | `data\app\GPUCache` / `Cache_Data` / `Dawn*` | 可删 |
| 启动日志 | `data\logs\startup.jsonl` | JSONL（追加） |
| 授权 | `license.ellen` + `clock.bin` | 二进制（带完整性校验） |

`profile` 目录名随授权状态变化（实测：`trial-v3-20260930-95a1edae`），即**试玩与正式版可能落在不同 profile**——`[待确认]` 切换授权后历史聊天是否自动继承。

Python 运行时固定路径（`runtime-paths.cjs`）：`runtime\python\python.exe`、`runtime\realtime\python\Scripts\python.exe`、本地 ASR 模型 `runtime\models\faster-whisper-large-v3-turbo`。

### 7.2 聊天库表（`chat-store.cjs`）

`conversations`（id / title ≤80 字 / created_at / updated_at）、`messages`（id / conversation_id / role ∈ user·assistant / text / status / created_at）+ 附属表 `message_usage`、`message_voice_delivery`、`message_attachments`、`message_deliveries`、`message_origin`、`message_stickers`、`message_calls`。

写消息用 `BEGIN IMMEDIATE` 事务；会话删除做级联清理。

### 7.3 备份与恢复

- **聊天导出/导入**：`chat-io.cjs`（0.2.5 新增）
- **自动清理**：**目标是不设上限**（YG 2026-10-27 定）。当前实现是硬编码 10：
  `chat-service.cjs` 的 `connect()` 里 `this.historyAutoCleanup ? this.store.trimHistory(10, t).length : 0`；
  `chat-store.trimHistory(e,s)` 只在 `e===10` 时放行，否则抛"自动清理仅支持保留10个聊天。"。
  **属待改代码**，改动时把 `tests/chat-store.test.cjs` 里"自动清理只接受保留 10 个聊天"那条用例一并改掉。
- **无云同步**：设计如此。备份 = 手工复制 `data/` 目录

---

## 八、适用边界（第一版至今刻意不做的事）

1. 用户注册 / 登录 / 多用户 / 权限体系
2. 云同步、云数据库、多设备漫游
3. ~~手机端与 PC 端数据互通~~ → **长期要做**（YG 2026-10-27 定）。现状两端完全独立：PC 用 `ELLEN1` / `desktop-v1` / sqlite，安卓用 `ELLENA1` / `android-v1` / AndroidKeyStore，数据结构也不同。属独立立项，不在当前版本。
4. 公网部署、任何形式的外部访问入口
5. 与社交平台（微信/抖音/B站）的数据对接
6. ~~在线内容商城~~ → **不做 DLC**（YG 2026-10-27 定）

---

## 九、验收标准

改任何功能都要过这张表。**"能跑"不算通过**。

### 9.1 每次改动的最低门槛

| # | 验收项 | 判定方法 |
|---|---|---|
| A0 | **冒烟测试全绿** | `pwsh -File .agents\test.ps1` 输出 `[PASS] 全部通过`（当前 30 项） |
| A1 | 启动无异常 | 双击 `ellen.exe` 到主界面出现，`data/logs/startup.jsonl` 无 error |
| A2 | 聊天主链路通 | 发一句话 → 收到流式回复 → 重启应用后该条仍在 |
| A3 | 未激活态正确 | 删掉 `license.ellen` → 应进激活页而不是崩 |
| A4 | 数据不丢 | 改前改后 `conversations.sqlite` 里的历史消息条数不减 |
| A5 | 不进 git 的目录没被碰 | `git status` 干净（`data/` `runtime/` 不在版本控制里） |

### 9.2 分模块验收

| 模块 | 验收点 |
|---|---|
| 记忆 | 说一件具体的事 → 重启 → 她能回忆起来；打开回忆页能看到该条且能追到原话 |
| 纠正 | 纠正一条错误记忆 → 原文 `source_events` 不变、`memories` 新增版本、`decisions` 有记录 |
| 情绪 | 触发情绪变化 → 情绪条数值与原因同步变化，重启后保留 |
| 语音 | 点通话 → 能听到她说话、能打断；语音失败时降级为文字且提示明确 |
| 角色切换 | 切到另一个角色 → 记忆、外观、聊天记录互不串 |
| 授权 | `trial` 到期 → 提示文案正确；`perpetual` 不检查时间 |
| 剧情模式 | `--story` 启动 → 走剧情界面而非日常界面 |

### 9.3 发布前额外门槛

- `艾莲电脑版-发行包` 必须由 `python 工具\更新.py 打包` 重新生成（**当前已滞后：缺 `src/chat-io.cjs`**）
- 打包后核对：`src/` 文件数与源码一致、`chat-io.cjs` 在包内、`external-integrity.json` 重新生成并与包内文件 hash 一致
- 装机测试：干净目录首次启动 → 激活 → 聊天 → 关闭 → 重开数据还在

---

## 十、已知缺口与风险（截至 0.2.5）

| # | 缺口 | 影响 | 状态 |
|---|---|---|---|
| 1 | 无自动化测试 | 改一处不知坏几处，全靠人肉点 | **已解决**：`tests/` 30 项冒烟（授权格式/聊天库/角色卡解析），`pwsh -File .agents\test.ps1` |
| 2 | 无版本存档历史 | 改坏回不去 | **已解决**：git 基线 `5806c67` |
| 3 | 发行包滞后于源码 | 发给用户的包缺功能 | 待重新打包 |
| 4 | 主进程代码被压缩成单行 | 无法 review、diff 噪音大 | 本轮不动，记录在案 |
| 5 | 无 PRD | 每次新会话重新摸代码 | **本文档** |
| 6 | `data/` 无自动备份 | 硬盘坏了全丢 | `[待确认]` 是否需要导出向导 |

---

## 十一、决策记录与待确认

### 11.1 已定（YG 2026-10-27）

| # | 事项 | 决定 | 性质 |
|---|---|---|---|
| 1 | 会话数量 | **不设上限** | 待改代码（当前硬编码 10，见 7.3） |
| 2 | DLC | **不做** | 待下线入口（17 个文件已在 `src/licensing/`） |
| 3 | 安卓 / PC 互通 | **要做** | 独立立项，不在当前版本 |
| 4 | 模型目录 | **可自定义** | 已支持，无需改代码（见 5.7） |
| 5 | 云端语音 | 只有 MiniMax 一家；本地另有 GPT-SoVITS 一条独立链路 | 见 5.4 |

### 11.2 待确认

1. **剧情模式**（`story/`）是独立产品线还是主产品的附属玩法？它的角色卡"博主"是模板还是正式内容？
2. **本地语音的 Python 解释器路径**写死在 `D:/AI-Local/新想法/GPT-SoVITS-v2ProPlus-20260921/.venv/Scripts/python.exe`，那个目录还在吗？要不要改成可配置？
3. **试玩与正式不同 profile**（实测 `trial-v3-20260930-95a1edae`）：从试玩转永久激活后，原聊天记录与记忆是否要自动继承？
