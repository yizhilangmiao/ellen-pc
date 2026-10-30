# 艾莲 · Ellen

一个本地优先的 AI 陪伴应用。桌面端（Electron）+ 安卓端（APK），人格、记忆、亲密度、信件、主动消息、语音都在本机跑，只有模型推理走你自己配的接口。

- 当前版本：`0.1.23`
- 桌面端：Electron 44 / Node 24，源码在本仓库
- 安卓端：由桌面端同源的构建产物打包成 APK，仓库里只放注入层与打包脚本
- 依赖：**零运行时依赖**，`package.json` 的 `dependencies` 为空

> 这个仓库是**源码存档**，不含可执行运行时（1.4 GB 的 models/python/realtime）和玩家真实数据。clone 下来能读、能改、能跑测试；要跑起界面得配一台装过本应用的机器，见下文「跑起来」。

---

## 一、进度总览

| 模块 | 状态 | 说明 |
|---|---|---|
| 桌面端主壳与启动链 | ✅ 稳定 | 启动进度、诊断、完整性校验、单实例、窗口吸附 |
| 会话与存储 | ✅ 稳定 | 聊天记录、去重、会话收束行为、伙伴会话状态 |
| 记忆系统 | ✅ 可用，持续调优 | 混合召回、周期维护、会话摘要、情绪状态、关系记忆 |
| 人格与角色包 | ✅ 稳定 | 角色卡、世界书、表达样本、当轮接话、多角色槽位 |
| 亲密度与信件 | ✅ 已上线 | 阶段推进、信件撰写/收发、信件 MVP 界面与动画 |
| 主动消息 | 🚧 收尾 | 三层闸门已跑通，正在接入与调参 |
| 双端互通 | 🚧 进行中 | 手机资料导入/导出/归档 |
| 3D 记忆爆炸图（星图） | 🧭 开工阶段 | 设计已定，尚无代码 |
| 记忆优化 | 🚧 持续 | 召回权重、摘要质量 |
| 更多角色 | 🚧 内容制作 | 机制已通，缺新角色内容 |
| 剧情模式 | ✅ 可用 | 独立入口，与主聊天分库 |

### 已落地

**主壳与启动** — `boot.dev.cjs`（开发入口，当前 `main`）、`boot.cjs`（正式入口）、`src/startup-progress.cjs`、`src/boot-integrity.cjs`、`external-integrity.json`。启动过程写 `data/logs/startup.jsonl`，看 `page-loaded` 那一行判断有没有真起来。

**会话** — `src/chat-store.cjs`、`src/chat-io.cjs`（导入导出 + 去重）、`src/companion-session.cjs`、`src/close-behavior.cjs`、`src/ui/conversation-manager.js`。

**记忆（`memory/src/`，20 个模块 + 3 个 schema）** — `hybrid-recall.cjs` 把关联召回和词面召回合并打分；`embeddings.cjs` / `embedding-{assets,process,worker}.cjs` 管本地向量模型；`memory-batch.cjs` 周期维护；`learned-impressions.cjs` 沉淀印象；`mood-state.cjs` 情绪状态；`relationship-store.cjs` + `bond.cjs` + `relationship-policy.cjs` 管亲密度与关系阶段；`character-context.cjs` / `character-selection.cjs` 管角色上下文组装；`conversation-preferences.cjs` / `customer-profile.cjs` 管偏好与档案。

**人格** — `characters/` 下三个目录：`_模板`（新建角色的空壳）、`ellen`（核心档案、世界设定、背景补充世界书、表达样本、当轮接话、原作记忆）、`ellen-lover`。当前激活角色写在 `characters/active-card.json`。

**情绪** — `src/emotion-runtime.cjs`、`src/emotion-prompt.md`、`src/emotion-schedule.cjs`。情绪不是每轮硬塞，按日程起伏。

**信件与亲密度** — `src/letter-composer.cjs`（撰写）、`src/letters-actions.cjs`（投递与读取）、`src/ui/letters-mvp.{js,css}`（界面与动画）。方案在 `docs/信件UI与动画-方案.md`、`docs/亲密度与信件-方案.md`。

**主动消息 v2** — `src/proactive-gate.cjs` 本地预筛（三档：安静 / 标准 / 黏人）、`src/activity-profile.cjs` 学作息、`src/open-threads.cjs` 记未完结话题。三道闸门都过才允许主动开口，避免半夜轰炸。

**语音** — `src/voice-{messages,profiles,provider-settings}.cjs`、`src/dictation-worker.py`、`src/ui/voice-*.js`。语音克隆参考音在 `src/assets/voice-clone/`。

**界面与桌面** — `src/ui/index.html` 是主界面；`appearance-{store,actions}.cjs` 管外观；`desktop-mini.cjs` + `desktop-controls.js` 管小窗与桌面控件；`window-pin.cjs` / `window-presentation.cjs` 管置顶与窗口表现；另有 `background-music.js`、`translation.js`、`token-usage.js`、`updates.js` + `src/updating/`（升级器）、`src/licensing/`（授权）。

**剧情模式** — `story/` 是独立入口，自己的 `index.html` / 服务 / 状态 / 语音 / 模型选择器，与主聊天不共库。角色卡格式见 `story/博主角色卡-格式整理.json`。

### 进行中（下面五件是当前主线）

**1. 3D 记忆爆炸图（星图）** — 目标是把记忆库变成一张能点、能拖、能看清时间与关联的星图：每条记忆一个节点，关联召回打出的权重决定连线和亮度，时间轴决定层次。当前**仓库里还没有对应模块**（`src/` / `story/` 搜 `星图|constellation` 零命中），处在设计定稿与开工阶段。落地时预计新增 `src/memory-map.cjs`（数据整形：记忆 → 节点/边）与 `src/ui/memory-map/*`（渲染层），数据源直接吃 `memory/src/hybrid-recall.cjs` 的召回结果。

**2. 主动发消息** — 机制已经在跑（`proactive-gate` / `activity-profile` / `open-threads` 三件套 + 三项测试），剩下的是接进真实对话流、调阈值、验收“该开口时开口、不该开口时闭嘴”。

**3. 双端互通** — `src/mobile-archive.cjs`（31.8 KB）做桌面端与手机端之间的资料归档、导入、导出；配套测试 `mobile-archive` / `mobile-archive-fixtures` / `mobile-export` / `mobile-import-wiring`。目标是桌面聊过的东西手机上接得上，手机上的资料也能回到桌面。

**4. 记忆优化** — 混合召回与周期维护已上线，继续调：召回权重配比、摘要压缩质量、长期记忆不遗忘但不胡说。

**5. 更多角色** — 角色包机制已通（`src/character-pack.cjs`、`characters/_模板`、多角色槽位、角色上下文隔离），现在缺的是新角色的内容制作与上线流程。

---

## 二、目录地图

```
.
├─ boot.cjs / boot.dev.cjs     入口（后者是开发用，当前 main）
├─ external-integrity.json     文件完整性清单
├─ package.json                ellen-companion 0.1.23，零依赖
├─ src/
│  ├─ main.cjs                 主进程
│  ├─ chat-* / companion-*     会话与存储
│  ├─ emotion-*                情绪运行时
│  ├─ proactive-gate.cjs       主动消息第一道闸门
│  ├─ activity-profile.cjs     作息画像
│  ├─ open-threads.cjs         未完结话题台账
│  ├─ mobile-archive.cjs       双端资料归档
│  ├─ letter-* / letters-*     信件
│  ├─ character-pack.cjs       角色包
│  ├─ voice-*                  语音
│  ├─ ui/                      渲染层（180 个文件，含音乐/字体/立绘素材）
│  ├─ assets/                  语音克隆参考音等
│  ├─ licensing/ updating/     授权与升级器
│  └─ vendor/                  第三方前端库
├─ memory/src/                 记忆系统（20 cjs + 3 sql）
├─ characters/                 角色卡与角色包（_模板 / ellen / ellen-lover）
├─ story/                      剧情模式独立入口
├─ docs/                       设计文档
└─ tests/                      冒烟测试
```

---

## 三、跑起来

**测试（不需要运行时，随时可跑）**

```powershell
# 仓库根目录
node --test tests\*.test.cjs
```

也可以走工程脚本（会顺手做环境体检）：`pwsh -File .agents\test.ps1`，通过打印 `[PASS] 全部通过`。

**界面**（需要一台装过艾莲的机器，把本仓库放进应用的 `resources\app`）

这台机器上应用装在 `E:\ailian\艾莲电脑版\创作版\`，源码树就是 `resources\app`。所以「本仓库」= 那个目录本身。

```powershell
# 必须带 --no-sandbox；必须先清掉 ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE=''
& 'E:\ailian\工具\electron-runtime\ellen.exe' --no-sandbox --disable-gpu --disable-features=Vulkan
```

不带 `--no-sandbox` 会秒退（退出码 `0x80000003`，日志全空，看起来像双击没反应）；带着 `ELECTRON_RUN_AS_NODE=1` 会退化成 node 模式静默退出。起来后看 `data/logs/startup.jsonl` 有没有新 run 的 `page-loaded`（文件里是 UTC，本地 +8），正常 6~8 个 ellen 进程。

改渲染层时用 `pwsh -File E:\ailian\工具\脚本\start-dev.ps1`（带 `-Isolated` 会把数据写到临时目录，不碰真实聊天记录；带 `-Port 9337` 换调试端口）。

---

## 四、这个仓库里没有的东西

| 目录 | 体积 | 为什么不进来 |
|---|---|---|
| `runtime/` | ~1.4 GB | 本地模型、Python 环境、实时语音后端，二进制，随安装包分发 |
| `data/` | ~6 MB | 真实聊天记录、日志、数据库，属于玩家私人数据 |
| `memory/node_modules/` `memory/模型缓存/` | 大 | 依赖与向量模型缓存，可重建 |

`src/ui/assets/` 里的音乐、字体、立绘是随源码入库的（约 100 MB），所以 clone 会有 200 MB 左右——这些是应用的一部分，不进仓库就跑不出界面。单个最大文件 27.68 MB（`src/ui/assets/music/ellen-daily.flac`），在 GitHub 100 MB 单文件上限内。

---

## 五、文档

| 文件 | 内容 |
|---|---|
| `docs/PRD.md` | 首版 PRD，从源码反推 + 后续决策落档 |
| `docs/人格流程.md` | 人格是怎么组装的：档案 → 世界书 → 表达样本 → 当轮接话 |
| `docs/亲密度与信件-方案.md` | 关系阶段推进与信件机制 |
| `docs/信件UI与动画-方案.md` | 信件界面的视觉与动效 |
| `tests/README.md` | 测试怎么跑、怎么加 |

---

## 六、当前版本与近期提交

版本号在 `package.json`（`0.1.23`）。近期提交：

```
dbbf908 wip: 亲密度/主动门控/开放线索 未提交部分归档
8a5ad65 feat: 信件系统 + 亲密度阶段 + 角色包 + 手机资料归档
651ac04 feat(memory): 关联召回 + 词面召回 + 周期维护 + 会话摘要
7880eee docs(prd): 落 YG 2026-10-27 的五项决定
240119f test: 补 30 项零依赖冒烟测试
```

提交信息用 `type(scope): 中文说明`，`type` 取 `feat / fix / docs / test / chore / wip`。
