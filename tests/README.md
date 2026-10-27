# tests/ —— 冒烟测试

## 怎么跑

```powershell
cd E:\ailian
pwsh -File .agents\test.ps1            # 全部
pwsh -File .agents\test.ps1 -File chat # 只跑文件名含 chat 的
```

通过会打印 `[PASS] 全部通过`，退出码 0；失败退出码 1 并列出不通过的用例。

**别直接敲 `node --test`**：本机 PATH 上没有 node，唯一可用的是 electron runtime，且必须先设 `ELECTRON_RUN_AS_NODE=1`、把 `TMP`/`TEMP` 指到 E 盘（`%LOCALAPPDATA%\Temp` 在 electron runtime 下会报 EPERM）。这些 `.agents\test.ps1` 都替你做了。

## 测什么

| 文件 | 覆盖 | 为什么重要 |
|---|---|---|
| `licensing-format.test.cjs` | 机器码生成/校验、授权字段校验（产品/版本/keyId/id/时间/kind 组合） | 授权错了用户直接被挡在门外 |
| `chat-store.test.cjs` | 建库 schema、会话创建、标题上限 80、删除、清理上限 10、消息落库 | 聊天记录是用户最不能丢的东西 |
| `character-card.test.cjs` | 角色卡解析（V2/V3/纯文本/数组/未知 spec/BOM/NUL）、crc32 | 导入坏了产品就没内容 |

## 只测纯函数与库，不测 Electron

这些测试全部零依赖（只 `node:test` + `node:assert`，SQLite 走 Node 24 内置的 `node:sqlite`），不启动 Electron、不开窗口、不碰用户真实数据（临时库建在 `_临时\test-tmp`，跑完即删）。

需要 IPC 或窗口行为的，不在这一层测——那只能人肉验收（见 `docs/PRD.md` 第九节）。

## 写测试时踩过的坑（别再踩）

1. **`chat-store.cjs` 导出是 `{ ChatStore }`**，不是类本身。`const ChatStore = require(...)` 拿到的是对象。
2. **`ChatStore` 没有 `list()` 方法**。查会话/消息直接 `new DatabaseSync(file).prepare(...)` 读表，这样测的才是真 schema。
3. **`crc32()` 只接受 Buffer**。传字符串不报错但结果无意义（`for..of` 逐字符 `t ^= 'a'` → NaN → 0）。它有标准值：`crc32(Buffer.from("123456789")) === 3421780262`。
4. **临时目录**：`os.tmpdir()` 在 electron runtime 下指向 `%LOCALAPPDATA%\Temp` 会 EPERM，runner 已把 `TMP`/`TEMP` 改到 `_临时\test-tmp`。
