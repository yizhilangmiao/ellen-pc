"use strict";
/* 好奇观察（v2）：看得见屏幕上的窗口，并且记得自己问过什么
 *
 *  - scan()        只枚举窗口，便宜。标出「这次新出现的窗口」并登记进记忆。
 *  - ask({id,mode}) 对着某个窗口截一张缩略图，让视觉模型生成一句提问。
 *                   mode="first"  → 「你开这个干什么呀」（同一个窗口一生只问一次）
 *                   mode="follow" → 「还在这个窗口里忙吗」（之后再来才问）
 *
 * 记忆只存进程内（窗口句柄当 id），重启小人模式就重新认识一遍，这符合直觉。
 */
const { execFile } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "tools", "list-windows.ps1");
// 自身窗口、系统覆盖层、桌宠不该问的那些
const IGNORE = /小人模式|陪伴伙伴|Program Manager|Default IME|MSCTFIME|NVIDIA GeForce Overlay|Windows Input Experience|^WorkBuddy$|\.NET-BroadcastEventWindow/i;
const MAX_NOTES = 60;

function parseList(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  let data;
  try { data = JSON.parse(raw); } catch (_) { return []; }
  const arr = Array.isArray(data) ? data : [data];
  return arr.filter(w => w && typeof w.title === "string" && w.title.trim())
    .map(w => ({
      id: String(w.id == null ? "" : w.id),
      title: w.title.trim(),
      proc: String(w.proc || "").toLowerCase(),
      x: +w.x, y: +w.y, w: +w.w, h: +w.h
    }))
    .filter(w => w.id && w.id !== "0" && Number.isFinite(w.x) && w.w >= 360 && w.h >= 260);
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

const FALLBACK = {
  first: [
    t => `刚开的「${t}」，是要做什么呀？`,
    t => `咦，这个「${t}」是干什么用的？`,
    t => `你开「${t}」啦，我能问问是做什么的吗？`,
    t => `「${t}」…新开的？好奇。`
  ],
  follow: [
    t => `还在「${t}」里忙呀？`,
    t => `「${t}」弄完了吗？`,
    t => `你在这个窗口待好久了，还没忙完？`,
    t => `又在「${t}」前坐着，进展如何？`
  ]
};

function clean(text) {
  return String(text || "")
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(问题|回答|艾莲)[:：]\s*/, "")
    .slice(0, 42)
    .trim();
}

const PROMPT_FIRST = [
  "你是一只可爱的桌宠，刚注意到用户打开了一个新窗口。",
  "看一眼截图，用一句中文问问她刚打开这个窗口是要做什么（不超过 22 个字）。",
  "语气好奇、俏皮、口语化，像凑过去随口一问；不要描述画面细节。",
  "禁止复述或猜测密码、账号、姓名、聊天对象等隐私内容。",
  "只输出这句问题本身，不要引号、不要前缀、不要解释。"
].join("\n");

const PROMPT_FOLLOW = [
  "你是一只可爱的桌宠。你已经知道用户在这个窗口里做什么了，她还在里面忙。",
  "看一眼截图，用一句中文问问她还在忙什么、还要弄多久（不超过 22 个字）。",
  "绝对不要再说「这是干什么的」，换一种关心的、催一催的说法；不要描述画面细节。",
  "禁止复述或猜测密码、账号、姓名、聊天对象等隐私内容。",
  "只输出这句问题本身，不要引号、不要前缀、不要解释。"
].join("\n");

function createPeek({ screen, desktopCapturer, getGateway, getIdle }) {
  const notes = new Map(); // id -> { title, proc, first, last, count }
  let lastList = [];
  let cachedAt = 0;
  let cache = null;
  let scanning = null;
  let asking = false;
  let seeded = false;

  function scaleOf() {
    try { return screen.getPrimaryDisplay().scaleFactor || 1; } catch (_) { return 1; }
  }

  async function enumerate(maxAge = 1200) {
    const now = Date.now();
    if (cache && now - cachedAt < maxAge) return cache;
    if (scanning) return scanning;
    scanning = listWindows()
      .then(list => {
        const wins = list.filter(w => !IGNORE.test(w.title) && w.proc !== "ellen");
        cache = wins;
        cachedAt = Date.now();
        return wins;
      })
      .finally(() => { scanning = null; });
    return scanning;
  }

  function view(w) {
    const s = scaleOf();
    return {
      id: w.id,
      title: w.title.slice(0, 40),
      proc: w.proc,
      x: Math.round(w.x / s),
      y: Math.round(w.y / s),
      w: Math.round(w.w / s),
      h: Math.round(w.h / s)
    };
  }

  function prune(wins) {
    if (notes.size <= MAX_NOTES) return;
    const alive = new Set(wins.map(w => w.id));
    for (const id of [...notes.keys()]) {
      const n = notes.get(id);
      if (!alive.has(id) && !n.count) notes.delete(id);
    }
    while (notes.size > MAX_NOTES) {
      const first = notes.keys().next().value;
      notes.delete(first);
    }
  }

  // 新窗口的「新鲜期」：这么久了还没问出口，就当它是普通窗口，不再用「刚开的」问句
  const FRESH_MS = 20 * 60000;

  /* 只枚举：返回还值得用「刚开的」问句去问的窗口。
     第一次调用把所有已开着的窗口当作「早就开着」。
     只有真正问出口（note.first 被写上）才会从 fresh 里消失——
     中途模型失败/窗口关了，下一次扫描还能再问，不会被白吃一次机会。 */
  async function scan() {
    let idle = null;
    try { idle = getIdle ? getIdle() : null; } catch (_) {}
    const wins = await enumerate();
    lastList = wins;
    const now = Date.now();

    if (!seeded) {
      seeded = true;
      for (const w of wins) {
        if (!notes.has(w.id)) notes.set(w.id, { title: w.title, proc: w.proc, first: 0, last: 0, count: 0, firstSeen: 0 });
      }
      prune(wins);
      return { ok: true, seeded: true, fresh: [], count: wins.length };
    }

    for (const w of wins) {
      const n = notes.get(w.id);
      if (!n) notes.set(w.id, { title: w.title, proc: w.proc, first: 0, last: 0, count: 0, firstSeen: now });
      else if (n.title !== w.title) n.title = w.title; // 同一窗口换了标题（换页/换文件），不算新窗口
    }
    const alive = new Set(wins.map(w => w.id));
    for (const id of [...notes.keys()]) if (!alive.has(id)) notes.delete(id);
    prune(wins);

    return {
      ok: true,
      idle: typeof idle === "number" ? idle : null,
      count: wins.length,
      fresh: wins.filter(w => {
        const n = notes.get(w.id);
        return n && !n.first && !!n.firstSeen && now - n.firstSeen < FRESH_MS;
      }).map(view),
      // 可以追问的窗口：已经问过「干什么」，隔了一阵还没再聊过
      known: wins.filter(w => {
        const n = notes.get(w.id);
        return n && n.first > 0 && now - n.last > 9 * 60000;
      }).map(view)
    };
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

  async function askVision(gateway, dataUrl, title, mode) {
    if (!gateway || !dataUrl) return "";
    const messages = [{
      role: "user",
      content: [
        { type: "text", text: (mode === "follow" ? PROMPT_FOLLOW : PROMPT_FIRST) + `\n窗口标题：「${title}」` },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    }];
    const text = await gateway.complete({ messages, maxTokens: 60, purpose: "peek" });
    return clean(text);
  }

  async function ask({ id, mode } = {}) {
    if (asking) return { ok: false, reason: "busy" };
    asking = true;
    try {
      let idle = null;
      try { idle = getIdle ? getIdle() : null; } catch (_) {}
      if (typeof idle === "number" && idle > 240) return { ok: false, reason: "idle" };

      const wins = await enumerate(600);
      const target = wins.find(w => w.id === String(id)) ||
        (() => {
          try {
            const c = screen.getCursorScreenPoint(), s = scaleOf();
            const dx = c.x * s, dy = c.y * s;
            return wins.find(w => dx >= w.x && dx <= w.x + w.w && dy >= w.y && dy <= w.y + w.h);
          } catch (_) { return null; }
        })() ||
        wins[Math.floor(Math.random() * wins.length)];
      if (!target) return { ok: false, reason: "no-window" };

      const note = notes.get(target.id) || { title: target.title, proc: target.proc, first: 0, last: 0, count: 0 };
      notes.set(target.id, note);
      // 同一个窗口只允许问一次「这是干什么的」，之后强制转成追问
      const want = mode === "follow" ? "follow" : "first";
      const real = want === "first" && note.first ? "follow" : want;

      const thumb = await pickThumb(target.title);
      let question = "";
      try {
        question = await askVision(getGateway ? getGateway() : null, thumb, target.title, real);
      } catch (_) { question = ""; }
      if (!question) {
        const pool = FALLBACK[real];
        question = pool[Math.floor(Math.random() * pool.length)](target.title.slice(0, 16));
      }
      if (!/[?？]/.test(question)) question += "？";

      const now = Date.now();
      note.first = note.first || now;
      note.last = now;
      note.count = (note.count || 0) + 1;
      note.title = target.title;

      return {
        ok: true,
        mode: real,
        question,
        vision: !!thumb,
        first: real === "first",
        window: view(target)
      };
    } finally {
      asking = false;
    }
  }

  /* 兼容旧调用：来一次「随便看看」= scan 后对最该问的那个窗口提问 */
  async function run() {
    const s = await scan();
    if (!s.ok) return s;
    const pool = s.fresh.length ? s.fresh : s.known;
    if (!pool.length) return { ok: false, reason: "no-window" };
    return ask({ id: pool[Math.floor(Math.random() * pool.length)].id, mode: s.fresh.length ? "first" : "follow" });
  }

  function debug() {
    return { seeded, notes: [...notes.entries()].map(([id, n]) => ({ id, ...n })) };
  }

  function reset() {
    notes.clear();
    cache = null;
    cachedAt = 0;
    seeded = false;
  }

  return { scan, ask, run, debug, reset };
}

module.exports = { createPeek, listWindows, parseList };
