"use strict";
/* 好奇观察：枚举屏幕上的窗口 → 截取其中一个的缩略图 → 让视觉模型生成一句好奇的提问
   仅在「小人模式」里被偶尔调用，不进入聊天记录。 */
const { execFile } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "tools", "list-windows.ps1");
const IGNORE = /小人模式|艾莲 ?· ?陪伴伙伴|Program Manager|Default IME|MSCTFIME|NVIDIA GeForce Overlay|Windows Input Experience|^WorkBuddy$|\.NET-BroadcastEventWindow/i;

function parseList(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch (_) { return []; }
  const arr = Array.isArray(data) ? data : [data];
  return arr.filter(w => w && typeof w.title === "string" && w.title.trim())
    .map(w => ({ title: w.title.trim(), x: +w.x, y: +w.y, w: +w.w, h: +w.h }))
    .filter(w => Number.isFinite(w.x) && w.w >= 360 && w.h >= 260);
}

function listWindows(timeout = 5000) {
  return new Promise(resolve => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { timeout, windowsHide: true, maxBuffer: 1024 * 512, encoding: "utf8" },
      (err, stdout) => {
        if (err && !stdout) return resolve([]);
        resolve(parseList(stdout));
      }
    );
  });
}

const FALLBACK = [
  t => `「${t}」里是什么呀？看着好认真。`,
  t => `你在弄「${t}」吗？我有点好奇。`,
  t => `这个「${t}」是做什么用的？`,
  t => `「${t}」……我能问一句吗？`,
  t => `盯着「${t}」这么久，有意思吗？`,
  t => `「${t}」看得懂吗？我是不太懂。`
];

function clean(text) {
  return String(text || "")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(问题|回答|艾莲)[:：]\s*/, "")
    .slice(0, 42)
    .trim();
}

function createPeek({ screen, desktopCapturer, getGateway, getIdle }) {
  const seen = new Set();
  let running = false;

  function scaleOf() {
    try { return screen.getPrimaryDisplay().scaleFactor || 1; } catch (_) { return 1; }
  }

  async function pickThumb(title) {
    if (!desktopCapturer) return null;
    try {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 960, height: 600 },
        fetchWindowIcons: false
      });
      const key = title.slice(0, 24);
      const hit = sources.find(s => s.name === title) || sources.find(s => s.name && s.name.slice(0, 24) === key);
      if (!hit || hit.thumbnail.isEmpty()) return null;
      const png = hit.thumbnail.toPNG();
      if (!png || png.length < 4000) return null;
      return "data:image/png;base64," + png.toString("base64");
    } catch (_) { return null; }
  }

  async function askVision(gateway, dataUrl, title) {
    if (!gateway || !dataUrl) return "";
    const prompt = [
      "你是一只可爱的桌宠，正凑在用户旁边看屏幕上的一个窗口。",
      `这个窗口的标题是「${title}」。`,
      "看一眼截图，用一句中文问题问用户正在做什么（不超过 24 个字），语气好奇、俏皮、口语化，像随口一问。",
      "禁止复述或猜测密码、账号、姓名、聊天对象等隐私内容；不要描述画面细节，只问一个泛泛的好奇问题。",
      "只输出这句问题本身，不要引号、不要前缀、不要解释。"
    ].join("\n");
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    }];
    const text = await gateway.complete({ messages, maxTokens: 60, purpose: "peek" });
    return clean(text);
  }

  async function run() {
    if (running) return { ok: false, reason: "busy" };
    running = true;
    try {
      let idle = null;
      try { idle = getIdle ? getIdle() : null; } catch (_) {}
      if (typeof idle === "number" && idle > 240) return { ok: false, reason: "idle" };

      const wins = (await listWindows()).filter(w => !IGNORE.test(w.title));
      if (!wins.length) return { ok: false, reason: "no-window" };

      const fresh = wins.filter(w => !seen.has(w.title));
      const pool = fresh.length ? fresh : wins;
      let target;
      try {
        const c = screen.getCursorScreenPoint();
        const s = scaleOf();
        const dx = c.x * s, dy = c.y * s;
        target = pool.find(w => dx >= w.x && dx <= w.x + w.w && dy >= w.y && dy <= w.y + w.h) ||
                 pool[Math.floor(Math.random() * pool.length)];
      } catch (_) {
        target = pool[Math.floor(Math.random() * pool.length)];
      }
      if (seen.size > 24) seen.clear();
      seen.add(target.title);

      const s = scaleOf();
      const thumb = await pickThumb(target.title);
      let question = "";
      try { question = await askVision(getGateway ? getGateway() : null, thumb, target.title); } catch (_) { question = ""; }
      if (!question) question = FALLBACK[Math.floor(Math.random() * FALLBACK.length)](target.title.slice(0, 16));
      if (!/[?？]/.test(question)) question += "？";

      return {
        ok: true,
        question,
        vision: !!thumb,
        window: {
          title: target.title.slice(0, 40),
          x: Math.round(target.x / s),
          y: Math.round(target.y / s),
          w: Math.round(target.w / s),
          h: Math.round(target.h / s)
        }
      };
    } finally {
      running = false;
    }
  }

  return { run };
}

module.exports = { createPeek, listWindows, parseList };
