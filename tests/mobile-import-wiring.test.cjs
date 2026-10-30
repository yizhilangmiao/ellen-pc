"use strict";

// 接线契约：确认「导入」这条链在源码里真的接上了。
// main.cjs 与 ui 都是压缩写法的单行代码，这里只做存在性断言，
// 避免 IPC 名字写错、导出函数名对不上这类「测试全绿但点了没反应」的问题。
//
// 现在的设计：界面上只有一个「导入」按钮 → IPC importAuto →
// 主进程弹一次文件框 → 按后缀分派（.ellenpack 走手机资料包，其余走聊天记录）。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const appRoot = path.join(__dirname, "..");
const mainSrc = fs.readFileSync(path.join(appRoot, "src", "main.cjs"), "utf8");
const uiSrc = fs.readFileSync(path.join(appRoot, "src", "ui", "conversation-manager.js"), "utf8");
const archive = require("../src/mobile-archive.cjs");
const chatIO = require("../src/chat-io.cjs");

test("main.cjs 加载了 mobile-archive 并暴露手机资料包的 IPC 动作", () => {
  assert.ok(mainSrc.includes('mobileArchive=require("./mobile-archive.cjs")'), "main.cjs 没有 require mobile-archive");
  assert.ok(mainSrc.includes('if("importMobile"===e?.type)'), "缺少 importMobile 分支");
  assert.ok(mainSrc.includes("mobileArchive.importMobileArchive("), "importMobile 未调用 importMobileArchive");
  assert.ok(mainSrc.includes('if("previewMobile"===e?.type)'), "缺少 previewMobile 分支");
  assert.ok(mainSrc.includes("mobileArchive.previewMobileArchive("), "previewMobile 未调用 previewMobileArchive");
  // 仍然保留原来的 json 导入，不要被覆盖
  assert.ok(mainSrc.includes('if("import"===e?.type)return await chatIO.importChats('), "原有 import 分支被改掉了");
});

test("importAuto 会先选文件再按后缀分派", () => {
  assert.ok(mainSrc.includes('if("importAuto"===e?.type)'), "缺少 importAuto 分支");

  const i = mainSrc.indexOf('if("importAuto"===e?.type)');
  const gate = mainSrc.indexOf('if(checkIdle(),e?.libraryId!==', i);
  assert.ok(i > 0 && gate > i, "importAuto 应该在 libraryId 校验之前（导入和当前打开的历史无关）");
  const body = mainSrc.slice(i, gate);

  assert.ok(body.includes("chatIO.pickImportFile("), "importAuto 没有弹文件框");
  assert.ok(body.includes("mobileArchive.isMobileArchivePath("), "importAuto 没有按 .ellenpack 后缀判断");
  assert.ok(body.includes("mobileArchive.importMobileArchive("), "importAuto 手机资料包分支没接上");
  assert.ok(body.includes("chatIO.importChatFile("), "importAuto 聊天记录分支没接上");
  assert.ok(!body.includes('type:"importMobile"'), "importAuto 不该再去调 importMobile（会重复弹框）");
});

test("两条导入分支都会刷新历史列表", () => {
  // 导入写的是 store，聊天记录对话框读的是 service.state.threads，
  // 任一条分支忘了刷新，都会出现「提示导入成功但列表没变化」。
  const i = mainSrc.indexOf('if("importAuto"===e?.type)');
  const gate = mainSrc.indexOf('if(checkIdle(),e?.libraryId!==', i);
  const body = mainSrc.slice(i, gate);

  const mobilePart = body.slice(body.indexOf("isMobileArchivePath("), body.indexOf("chatIO.importChatFile("));
  const chatPart = body.slice(body.indexOf("chatIO.importChatFile("));

  assert.ok(mobilePart.includes("service.state.threads=service.store.list()"), "手机上那条分支没刷新列表");
  assert.ok(mobilePart.includes("service.update()"), "手机上那条分支没广播更新");
  assert.ok(chatPart.includes("service.state.threads=service.store.list()"), "聊天记录那条分支没刷新列表");
  assert.ok(chatPart.includes("service.update()"), "聊天记录那条分支没广播更新");
});

test("界面上只有一个导入按钮，走 importAuto", () => {
  assert.ok(uiSrc.includes('imp.id="history-import"'), "缺少导入按钮 id");
  assert.ok(uiSrc.includes('type:"importAuto"'), "导入按钮没有调用 importAuto");
  assert.ok(uiSrc.includes(".prepend(m,btn,imp)"), "三个按钮没有挂进聊天记录对话框");
  assert.ok(!uiSrc.includes("history-import-mobile"), "旧的「从手机导入」按钮应该已经合并掉了");
  assert.ok(uiSrc.includes('imp.title=""') || /imp\.title="选一个文件导入/.test(uiSrc), "导入按钮的提示没说清支持哪些文件");
});

test("chat-io 提供选文件与按路径导入两个入口", () => {
  assert.strictEqual(typeof chatIO.pickImportFile, "function", "缺少 pickImportFile");
  assert.strictEqual(typeof chatIO.importChatFile, "function", "缺少 importChatFile");
  assert.ok(Array.isArray(chatIO.IMPORT_FILTERS), "缺少 IMPORT_FILTERS");
  const exts = chatIO.IMPORT_FILTERS.flatMap((f) => f.extensions);
  for (const ext of ["json", "ellenchat", "ellenpack"]) {
    assert.ok(exts.includes(ext), `导入对话框没放行 .${ext}`);
  }
});

test("只有 .ellenPack 走手机资料包，聊天记录文件不会被误判", () => {
  const isMobile = archive.isMobileArchivePath;
  assert.strictEqual(typeof isMobile, "function", "mobile-archive 没有导出 isMobileArchivePath");

  // 手机端导出的实际文件名（大写 P），以及小写写法，都要认
  assert.strictEqual(isMobile("艾莲-聊天资料-2026-10-29.ellenPack"), true);
  assert.strictEqual(isMobile("艾莲相处资料-2026-10-29.ellenpack"), true);
  assert.strictEqual(isMobile("D:\\导出\\A.ELLENPACK"), true);

  // 电脑端聊天记录不能被当成资料包
  assert.strictEqual(isMobile("艾莲-聊天记录-2026-10-29.json"), false);
  assert.strictEqual(isMobile("艾莲-聊天记录-2026-10-29.ellenchat"), false);
  assert.strictEqual(isMobile("ellenpack.json"), false);
  assert.strictEqual(isMobile("readme.md"), false);
  assert.strictEqual(isMobile(""), false);
  assert.strictEqual(isMobile(undefined), false);
});

test("mobile-archive 与 chat-io 的契约一致", () => {
  assert.strictEqual(typeof archive.importMobileArchive, "function");
  assert.strictEqual(typeof archive.previewMobileArchive, "function");
  assert.strictEqual(typeof chatIO.applyImport, "function");
  // applyImport 认的格式必须和 toChatExport 产出的格式一致
  assert.strictEqual(archive.toChatExport({ records: [] }, {}).format, chatIO.FORMAT);
  assert.strictEqual(archive.toChatExport({ records: [] }, {}).version, chatIO.VERSION);
});
