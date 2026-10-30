"use strict";

// 开发版启动入口：由官方 boot.cjs 派生
// 差异：
//   1. 跳过 verifyExternal —— 开发目录不做 1.6GB 完整性校验
//   2. 允许 --inspect / --remote-debugging 等调试参数
//   3. 启动失败时把真实异常栈弹出来
//   4. 支持 ELLEN_DATA_DIR 覆盖数据目录（默认与官方版共用 %LOCALAPPDATA%\EllenCompanion\<kind>\app）

const path = require("node:path");
const { app, dialog } = require("electron");

// 沙箱在部分环境下初始化失败会让进程静默 exit 3 —— 表现就是「双击 exe 毫无反应」。
// 必须在 require("electron") 之后、app.whenReady() 之前关：此时 Chromium 还没 fork renderer，
// appendSwitch 仍然有效。这样就不必依赖 bat 传参数，双击 exe 即可启动。
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu-sandbox");

// 不要 disable-gpu —— 那会让整个界面走软件光栅化，拖动和挂件都会掉帧。

const kind = process.argv.includes("--story") ? "story" : "daily";

// userData 必须一开始就落在可写盘。Chromium 的 GPU 进程在主进程 setPath 之前就按这个路径
// 建 GPUCache / Code Cache，若指向 %LOCALAPPDATA%\EllenCompanion，那两个目录建不出来，
// 界面就退化成每帧重算 shader —— 表现就是拖窗口和小挂件掉帧。
app.setPath("userData", process.env.ELLEN_DATA_DIR
  ? path.resolve(process.env.ELLEN_DATA_DIR)
  : path.join(__dirname, kind === "story" ? "data-story" : "data", "app"));

if (kind === "daily") {
  require("./src/privileged-schemes.cjs").register();
}

async function start() {
  // 开发版不启用单实例锁：该环境下 SingletonLock 创建返回 0x5 拒绝访问
  // if (!app.requestSingleInstanceLock()) { app.exit(0); return; }

  await app.whenReady();

  const progress = await require("./src/startup-progress.cjs").createStartupProgress();

  try {
    // 原版这里还有 verifyExternal({root: __dirname + ".unpacked", manifest: require("./external-integrity.json")})
    // 开发目录不需要，直接跳过。
    progress.update({ message: "正在准备界面…" });
    require(kind === "story" ? "./story/story-main.cjs" : "./src/main.cjs");
    console.log("[boot.dev] main loaded, kind =", kind, "userData =", app.getPath("userData"));
  } catch (e) {
    try { progress.close(); } catch {}
    throw e;
  }
}

start().catch((e) => {
  console.error("[boot.dev] fatal:", (e && e.stack) || e);
  app.whenReady().then(() => {
    dialog.showErrorBox("艾莲启动失败（开发版）", String((e && e.stack) || e));
    app.exit(1);
  });
});
