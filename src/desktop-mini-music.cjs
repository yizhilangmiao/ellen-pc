"use strict";
// 听歌检测：拉起一个常驻的 PowerShell 进程每秒吐一行 JSON，
// 不再每 12 秒现起一个进程（PS 冷启动就要 700ms，一次查询 1.2s）。
// 常驻进程死掉时回落到一次性查询，功能不受影响。
const { spawn, execFile } = require("node:child_process");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "tools/now-playing.ps1");
const PS = "powershell.exe";
const ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT];

function createMusicProbe() {
  let child = null;
  let latest = null,
    latestAt = 0;
  let lastAsk = 0;
  let restarts = 0;
  let restartTimer = null;
  let stopped = false;
  let fbCache = null,
    fbAt = 0,
    fbRun = null;

  function parse(line) {
    const s = String(line).trim();
    if (!s || s[0] !== "{") return;
    let o;
    try {
      o = JSON.parse(s);
    } catch (_) {
      return;
    }
    if (!o || typeof o !== "object") return;
    latest = o;
    latestAt = Date.now();
  }

  function killChild() {
    if (!child) return;
    try {
      child.kill();
    } catch (_) {}
    child = null;
  }

  function start() {
    if (child || stopped) return;
    let c;
    try {
      c = spawn(PS, ARGS.concat(["-Watch", "-ParentPid", String(process.pid)]), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (_) {
      return;
    }
    child = c;
    let buf = "";
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
      if (buf.length > 8192) buf = "";
    });
    c.stderr.on("data", () => {});
    c.on("error", () => {
      if (child === c) child = null;
    });
    c.on("exit", () => {
      if (child === c) child = null;
      latest = null;
      latestAt = 0;
      if (stopped) return;
      // 只是「闲置自尽」或者连续崩溃就别急着拉起来；下次查询会自己重启
      if (Date.now() - lastAsk > 60000) return;
      restarts++;
      if (restarts > 5) return;
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (!stopped && Date.now() - lastAsk < 60000) start();
      }, 1500);
    });
  }

  function oneShot() {
    if (fbRun) return fbRun;
    fbRun = new Promise((resolve) => {
      execFile(PS, ARGS, { timeout: 7000, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
        fbRun = null;
        let out = { ok: false, playing: false };
        if (!err) {
          try {
            out = JSON.parse(String(stdout).trim() || "{}");
          } catch (_) {
            out = { ok: false, playing: false };
          }
        }
        if (!out || typeof out !== "object") out = { ok: false, playing: false };
        fbCache = out;
        fbAt = Date.now();
        resolve(out);
      });
    });
    return fbRun;
  }

  function query() {
    lastAsk = Date.now();
    restarts = 0;
    if (!child && !stopped) start();
    // 常驻进程每秒刷新，直接给最新值
    if (latest && Date.now() - latestAt < 4000) return Promise.resolve(latest);
    // 刚拉起还没吐数据：最多等 1.2 秒，别把第一次查询也拖成 1.2s
    if (child) {
      return new Promise((resolve) => {
        let tries = 0;
        const t = setInterval(() => {
          tries++;
          if ((latest && Date.now() - latestAt < 4000) || !child || tries > 12) {
            clearInterval(t);
            resolve(latest || { ok: false, playing: false });
          }
        }, 100);
      });
    }
    if (fbCache && Date.now() - fbAt < 2500) return Promise.resolve(fbCache);
    return oneShot();
  }

  function stop() {
    stopped = true;
    clearTimeout(restartTimer);
    killChild();
  }

  // 90 秒没人问就退出，不在后台白占一个 PowerShell
  const idle = setInterval(() => {
    if (child && Date.now() - lastAsk > 90000) killChild();
  }, 15000);
  if (idle.unref) idle.unref();

  process.on("exit", () => {
    try {
      child && child.kill();
    } catch (_) {}
  });

  return { query, stop };
}

module.exports = { createMusicProbe };
