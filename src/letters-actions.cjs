"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { composeLetter } = require("./letter-composer.cjs");

/**
 * 信件与亲密度：主进程侧动作。
 * 数数与升阶在 memory/src/bond.cjs，写正文在 letter-composer.cjs，这里只做接线与回填。
 */
const LOG = path.join(__dirname, "..", "data", "logs", "letters.log");
function trace(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, new Date().toISOString() + " " + line + "\n", "utf8");
  } catch {}
}

trace("module loaded");

/** 从 runtime 里摸出「这个角色是谁、她怎么说话」。pack 缺失时退回核心档案。 */
function personaOf(runtime) {
  const pack = runtime?.characterPack || null;
  const card = pack?.card || null;
  const name = card?.name || pack?.name || runtime?.characterName || "艾莲";
  const persona =
    (typeof pack?.persona === "string" && pack.persona) ||
    (typeof runtime?.coreOverride === "string" && runtime.coreOverride) ||
    (typeof runtime?.cardContext === "string" && runtime.cardContext) ||
    "";
  return { name, persona };
}

function createLettersActions({ getRuntime, gateway = null, loadHistory = null }) {
  trace("actions created");

  const bond = () => {
    const runtime = getRuntime?.();
    const instance = runtime?.bond;
    if (!instance) throw new Error("亲密度还没准备好，请先聊一句再试。");
    return instance;
  };

  // ---- 历史追认：装应用之前就存在的聊天，按「每条 +1、每天 +3」补算，只跑一次 ----
  let backfillTried = false;
  function readHistory() {
    if (typeof loadHistory !== "function") return [];
    try {
      const rows = loadHistory();
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      trace("history read failed :: " + (error && error.message ? error.message : String(error)));
      return [];
    }
  }
  function runBackfill(instance, force = false) {
    if (!force && (backfillTried || !instance.needsBackfill())) return { replayed: 0, skipped: true };
    backfillTried = true;
    const rows = readHistory();
    const out = instance.backfill(rows);
    trace(`backfill 读到 ${rows.length} 条，追认 ${out.replayed} 条 skipped=${!!out.skipped}`);
    return out;
  }

  async function composeOne(id) {
    const runtime = getRuntime();
    const instance = bond();
    const context = instance.letterContext(id);
    if (!context) throw new Error("找不到这封信。");
    if (context.letter.status === "ready") return context.letter;

    const { name, persona } = personaOf(runtime);
    const signature = context.letter.signature;
    trace(`compose start ${context.letter.stage} target=${context.wordTarget} excerpts=${context.excerpts.length}`);
    const started = Date.now();
    const result = await composeLetter({ gateway, context, persona, characterName: name, signature });
    trace(`compose done ${context.letter.stage} ${result.count}字 ${Date.now() - started}ms short=${!!result.short}`);

    if (result.short) {
      throw new Error(`模型只写出 ${result.count} 字，没到 ${context.wordTarget} 字，这次先保留模板。`);
    }
    return instance.applyComposed(id, { body: result.body, model: result.model || null });
  }

  return async function lettersActions(request) {
    const type = request?.type;
    trace("enter " + type);
    try {
      if (!["state", "list", "read", "unread", "unlock", "compose", "composeAll", "backfill", "debug"].includes(type)) {
        throw new Error("不支持的信件操作。");
      }

      if (type === "state") {
        const instance = bond();
        try {
          runBackfill(instance);
        } catch (error) {
          trace("backfill failed :: " + (error && error.message ? error.message : String(error)));
        }
        return { ...instance.state(), pending: instance.pendingLetters().length };
      }
      if (type === "list") return bond().listLetters();
      if (type === "unread") return bond().nextUnread();

      if (type === "backfill") {
        const instance = bond();
        const out = runBackfill(instance, true);
        return { ...out, state: instance.state(), pending: instance.pendingLetters().length };
      }

      if (type === "read") {
        const id = request?.id;
        if (typeof id !== "string" || !id) throw new Error("缺少要打开的信。");
        const instance = bond();
        const found = instance.listLetters().find((l) => l.id === id) || null;
        if (!found) return null;
        // 没拆封的情书只回一个壳，正文不往前端送
        if (found.locked) {
          return {
            locked: true,
            letter: {
              id: found.id,
              stage: found.stage,
              kind: found.kind,
              title: found.title,
              label: found.label,
              created_at: found.created_at,
            },
          };
        }
        instance.markRead(id);
        return instance.listLetters().find((l) => l.id === id) || null;
      }

      if (type === "unlock") {
        const id = request?.id;
        if (typeof id !== "string" || !id) throw new Error("缺少要打开的信。");
        const instance = bond();
        const opened = instance.unlockLetter(id);
        if (!opened) throw new Error("这封信不在。");
        instance.markRead(id);
        trace("unlock " + id);
        return instance.listLetters().find((l) => l.id === id) || null;
      }

      // 把某一封（或所有未完成的）交给模型写成正式正文
      if (type === "compose") {
        const id = request?.id;
        if (typeof id !== "string" || !id) throw new Error("缺少要写的信。");
        return await composeOne(id);
      }
      if (type === "composeAll") {
        const instance = bond();
        const pending = instance.pendingLetters();
        const done = [];
        const failed = [];
        for (const item of pending.slice(0, 5)) {
          try {
            done.push(await composeOne(item.id));
          } catch (error) {
            failed.push({ id: item.id, stage: item.stage, message: error?.message || String(error) });
          }
        }
        return { done, failed };
      }

      // debug：只在测试版里用，正式版删掉这段就行
      const op = request?.op;
      if (op === "bump") {
        const n = Number(request?.n);
        if (!Number.isInteger(n) || n < 1 || n > 20000) throw new Error("调试步数不合法。");
        trace("debug bump " + n);
        return bond().debugBump(n);
      }
      if (op === "reset") {
        trace("debug reset");
        return bond().debugReset();
      }
      if (op === "replay") return bond().replay({ force: true });
      throw new Error("未知的调试动作。");
    } catch (error) {
      trace("FAIL " + type + " :: " + (error && error.message ? error.message : String(error)));
      throw error;
    }
  };
}

module.exports = { createLettersActions, personaOf };
