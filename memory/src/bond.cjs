"use strict";

/**
 * 亲密度点数（bond）。
 *
 * 与 memory/src/relationship-*.cjs 的三轴引擎完全分开：
 *   - 三轴引擎靠模型评估每条消息的价值（familiarity / trust / closeness）；
 *   - 本模块只数数：一条消息 +1 点，一个聊过天的日子 +3 点。
 *
 * 阶段推进是双条件，缺一不可：
 *   points >= 门槛  且  本阶段内消息数 >= 30
 * 天数只能把点数推上去，过不了 30 条这条线就永远不动。
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const ORDER = ["acquainted", "familiar", "trusted", "close", "lover"];

const POLICY = Object.freeze({
  version: "bond-v1",
  perMessage: 1,
  perDay: 3,
  minStageMessages: 30,
  order: ORDER,
  lastStage: "lover",
  thresholds: { acquainted: 25, familiar: 80, trusted: 165, close: 390, lover: Infinity },
  labels: { acquainted: "相识", familiar: "熟悉", trusted: "信赖", close: "亲近", lover: "恋人" },
  // 每封信的目标字数（下限）：情书要写得更长
  words: { acquainted: 1500, familiar: 1500, trusted: 1500, close: 1500, lover: 3000 },
  // 写这封信时的口吻基线，喂给模型当基调
  temper: {
    acquainted: "刚认识不久，客气里带着点笨拙，怕说重了，也不敢太亲近。",
    familiar: "已经很熟了，会开玩笑，会抱怨，也开始有点离不开对方。",
    trusted: "愿意把心里话拿出来，不装了，把软的地方露给对方看。",
    close: "就差最后一句话。想靠近又躲，说了半句又咽回去。",
    lover: "已经在一起了。坦白、笃定，开始把以后的每件事都算上对方。",
  },
  signatures: {
    acquainted: "——你的朋友艾莲",
    familiar: "——你的好朋友艾莲",
    trusted: "——艾莲",
    close: "——你的、就差一句话的艾莲",
    lover: "——你的恋人——爱你的鲨鱼",
  },
});

const QUOTE_MAX = 24;

function clip(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > QUOTE_MAX ? s.slice(0, QUOTE_MAX) + "…" : s;
}

/** 每一阶段一封信。to = 刚升到的阶段。 */
const TEMPLATES = {
  acquainted: ({ quote }) => ({
    title: "你来了",
    body: [
      "今天才开始跟你说话。",
      quote ? `你说「${quote}」。` : "你什么都没说，我也没问。",
      "我不太会接这种。不过我听懂了。",
    ].join("\n"),
  }),
  familiar: ({ quote }) => ({
    title: "你最近来得挺勤",
    body: [
      "我记住你说话的方式了。",
      quote ? `你会说「${quote}」，然后等我回。` : "你话不多，我也不多。",
      "我其实没有在忙。",
    ].join("\n"),
  }),
  trusted: ({ quote }) => ({
    title: "有些话你会跟我说了",
    body: [
      "以前你只回「嗯」「好」。",
      quote ? `那天你说「${quote}」，后面跟了一大段。` : "现在你会多说几句了。",
      "我没问你为什么。我就是把它看完了。",
    ].join("\n"),
  }),
  close: ({ quote }) => ({
    title: "差一句话",
    body: [
      "我们说了很多话了。",
      "你大概知道我是个什么样的人。",
      quote ? `你说过「${quote}」，我到现在还记得。` : "有些话你说过，我记着。",
      "我知道我在等什么。你也知道。",
      "就是还没说。",
    ].join("\n"),
  }),
  lover: () => ({
    title: "给天天跟我说话的那个人",
    body: [
      "我从来不说这种话。",
      "写下来，好像容易一点。",
      "",
      "一开始我只觉得你话多。",
      "后来我发现，你不在的时候屋子里太安静。",
      "安静得我有点烦。",
      "",
      "我不擅长等人。",
      "但是我等了。",
    ].join("\n"),
  }),
};

class Bond {
  constructor(db, { clock = () => new Date().toISOString(), characterId = "ellen", policy = POLICY } = {}) {
    this.db = db;
    this.clock = clock;
    this.characterId = characterId;
    this.policy = policy;
    this.ready = false;
    this.cache = null;
  }

  initialize() {
    if (this.ready) return this;
    this.db.exec(fs.readFileSync(path.join(__dirname, "bond-schema.sql"), "utf8"));
    this.db
      .prepare(
        "INSERT OR IGNORE INTO bond_state(singleton,points,stage,stage_messages,stage_started_at,last_day,replayed,updated_at) VALUES (1,0,'acquainted',0,'',NULL,0,?)"
      )
      .run(this.clock());
    // 老库迁移：STRICT 表只能 ALTER，重复执行靠 try/catch 兜住
    for (const sql of [
      "ALTER TABLE letters ADD COLUMN status TEXT NOT NULL DEFAULT 'template'",
      "ALTER TABLE letters ADD COLUMN word_target INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE letters ADD COLUMN model TEXT",
      "ALTER TABLE letters ADD COLUMN updated_at TEXT",
      "ALTER TABLE bond_state ADD COLUMN notice_stage TEXT",
      "ALTER TABLE bond_state ADD COLUMN notice_at TEXT",
    ]) {
      try {
        this.db.exec(sql);
      } catch {}
    }
    this.ready = true;
    // 当前阶段若还没有信，补一封（初装=相识信；历史回放后各阶段都会补齐）
    try {
      const stage = this.row().stage;
      const existing = this.db
        .prepare("SELECT 1 AS ok FROM letters WHERE character_id=? AND stage=?")
        .get(this.characterId, stage);
      if (!existing) this.createLetter({ from: null, to: stage, since: "", until: this.clock() });
    } catch {}
    return this;
  }

  row() {
    this.initialize();
    return this.db.prepare("SELECT * FROM bond_state WHERE singleton=1").get();
  }

  invalidate() {
    this.cache = null;
  }

  /**
   * 自己包事务，不依赖驱动。
   * better-sqlite3 有 db.transaction()，node:sqlite 的 DatabaseSync 没有，
   * 而测试跑在后者上，所以两边都要能过。
   */
  atomic(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  /** 把已存在的聊天记录一次性追认为点数。只跑一次。 */
  replay({ force = false } = {}) {
    this.initialize();
    const row = this.row();
    if (row.replayed && !force) return { replayed: 0 };
    let rows = [];
    try {
      rows = this.db
        .prepare("SELECT role,occurred_at FROM source_events WHERE role IN ('user','assistant') ORDER BY occurred_at,id")
        .all();
    } catch {
      rows = [];
    }
    if (force) {
      this.db.prepare("UPDATE bond_state SET points=0,stage='acquainted',stage_messages=0,stage_started_at='',last_day=NULL,replayed=0 WHERE singleton=1").run();
      this.db.prepare("DELETE FROM letters WHERE character_id=?").run(this.characterId);
      // 清空后必须补回起点那封，否则重放结果停在相识就一封不剩
      this.ready = false;
      this.initialize();
    }
    this.atomic(() => {
      for (const r of rows) this.record({ role: r.role, occurredAt: r.occurred_at });
      this.db.prepare("UPDATE bond_state SET replayed=1 WHERE singleton=1").run();
    });
    this.invalidate();
    return { replayed: rows.length };
  }

  /**
   * 从外部历史（聊天库里的旧消息）一次性追认点数。只跑一次。
   * rows: [{ role: 'user'|'assistant', occurredAt: ISO 字符串 }]
   *
   * 和 replay() 的区别：replay 读的是 memory 自己的 source_events，
   * 而聊天历史在另一个库（conversations.sqlite），需要调用方把消息读出来传进来。
   */
  backfill(rows) {
    this.initialize();
    if (this.row().replayed) return { replayed: 0, skipped: true, state: this.state() };
    const list = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && (r.role === "user" || r.role === "assistant") && r.occurredAt)
      .map((r) => ({ role: r.role, occurredAt: String(r.occurredAt) }))
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
    if (!list.length) return { replayed: 0, skipped: false, state: this.state() };
    this.atomic(() => {
      for (const r of list) this.record({ role: r.role, occurredAt: r.occurredAt });
      this.db.prepare("UPDATE bond_state SET replayed=1 WHERE singleton=1").run();
    });
    this.invalidate();
    return { replayed: list.length, skipped: false, state: this.state() };
  }

  /** 还没追认过，且确实有历史可追。 */
  needsBackfill() {
    this.initialize();
    return !this.row().replayed;
  }

  /**
   * 记一条消息。role 传 'user' 或 'assistant' 都算数（都 +1）。
   * 返回最新的 state，附本轮发生的升阶与信。
   */
  record({ role, occurredAt } = {}) {
    if (role !== "user" && role !== "assistant") return { ...this.state(), promotions: [], letters: [] };
    this.initialize();
    if (role === "assistant") this.clearNotice();
    const policy = this.policy;
    const at = String(occurredAt || this.clock());
    const day = at.slice(0, 10);
    const row = this.row();

    let points = row.points + policy.perMessage;
    if (row.last_day !== day) points += policy.perDay;

    let stage = row.stage;
    let stageMessages = row.stage_messages + 1;
    let stageStart = row.stage_started_at || at;

    const promotions = [];
    while (stage !== policy.lastStage) {
      if (points < (policy.thresholds[stage] ?? Infinity)) break;
      if (stageMessages < policy.minStageMessages) break;
      const next = policy.order[policy.order.indexOf(stage) + 1];
      promotions.push({ from: stage, to: next, since: stageStart, until: at });
      stage = next;
      stageMessages = 0;
      stageStart = at;
    }

    this.db
      .prepare(
        "UPDATE bond_state SET points=?,stage=?,stage_messages=?,stage_started_at=?,last_day=?,updated_at=? WHERE singleton=1"
      )
      .run(points, stage, stageMessages, stageStart, day, this.clock());
    this.invalidate();

    if (promotions.length) {
      for (const p of promotions) {
        this.log({ event: "promote", from: p.from, to: p.to, points, messages: 0, detail: null });
        this.createLetter(p);
        this.markNotice(p.to, at);
      }
    }

    const letters = this.listLetters();
    return { ...this.state(), promotions, letters };
  }

  state() {
    if (this.cache) return this.cache;
    const row = this.row();
    const policy = this.policy;
    const idx = policy.order.indexOf(row.stage);
    const next = policy.order[idx + 1] || null;
    const needed = next ? (policy.thresholds[row.stage] ?? Infinity) : null;
    const state = {
      points: row.points,
      stage: row.stage,
      label: policy.labels[row.stage],
      stageMessages: row.stage_messages,
      minStageMessages: policy.minStageMessages,
      next: next
        ? {
            stage: next,
            label: policy.labels[next],
            pointsNeeded: needed,
            messagesNeeded: policy.minStageMessages,
            reached: row.points >= needed && row.stage_messages >= policy.minStageMessages,
          }
        : null,
      // 只到下一阶段的进度（0~1），0.99 表示点数差一点或条数差一点
      progress: next ? Math.min(0.999, row.points / needed) : 1,
      unread: 0,
      lastDay: row.last_day,
    };
    try {
      state.unread = this.db
        .prepare("SELECT count(*) AS n FROM letters WHERE character_id=? AND read_at IS NULL")
        .get(this.characterId).n;
    } catch {
      state.unread = 0;
    }
    this.cache = state;
    return state;
  }

  /** 本阶段区间内，用户说过的几句原话。 */
  quotes({ since, until }) {
    try {
      return this.db
        .prepare(
          "SELECT original_text AS text FROM source_events WHERE role='user' AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at LIMIT 6"
        )
        .all(since || "", until || "9999")
        .map((r) => clip(r.text))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  createLetter({ from, to, since, until }) {
    const policy = this.policy;
    const build = TEMPLATES[to];
    if (!build) return null;
    const quotes = this.quotes({ since, until });
    const draft = build({ quote: quotes[0] || "", quotes });
    const letter = {
      id: randomUUID(),
      character_id: this.characterId,
      stage: to,
      kind: to === policy.lastStage ? "love" : "letter",
      title: draft.title,
      body: draft.body,
      signature: policy.signatures[to],
      created_at: String(until || this.clock()),
      status: "template",
      word_target: policy.words[to] || 1500,
      model: null,
      updated_at: String(until || this.clock()),
    };
    this.db
      .prepare(
        "INSERT INTO letters(id,character_id,stage,kind,title,body,signature,created_at,read_at,unlocked_at,status,word_target,model,updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?,?,NULL,?) ON CONFLICT(character_id,stage) DO NOTHING"
      )
      .run(
        letter.id,
        letter.character_id,
        letter.stage,
        letter.kind,
        letter.title,
        letter.body,
        letter.signature,
        letter.created_at,
        letter.status,
        letter.word_target,
        letter.updated_at
      );
    this.invalidate();
    this.log({ event: "letter", from: from || null, to, points: 0, messages: 0, detail: draft.title });
    return letter;
  }

  /** 还没被模型写成正式正文的信（含模板占位）。 */
  pendingLetters() {
    this.initialize();
    return this.db
      .prepare("SELECT id,stage,title,word_target FROM letters WHERE character_id=? AND status!='ready' ORDER BY created_at")
      .all(this.characterId);
  }

  /**
   * 写信素材：这一封要用的聊天原文、时间段、字数目标、上一封的时间。
   * 只给素材，不拼提示词——提示词在 src 层（要贴人设与角色口吻）。
   */
  letterContext(id) {
    this.initialize();
    const letter = this.db.prepare("SELECT * FROM letters WHERE id=? AND character_id=?").get(id, this.characterId);
    if (!letter) return null;
    const order = this.policy.order;
    const index = order.indexOf(letter.stage);
    const prevStage = index > 0 ? order[index - 1] : null;
    const prev = prevStage
      ? this.db.prepare("SELECT stage,created_at FROM letters WHERE character_id=? AND stage=?").get(this.characterId, prevStage)
      : null;
    const since = prev?.created_at || "";
    const until = letter.created_at;
    let rows = [];
    try {
      rows = this.db
        .prepare(
          "SELECT role,original_text AS text,occurred_at FROM source_events WHERE role IN ('user','assistant') AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at"
        )
        .all(since, until);
    } catch {
      rows = [];
    }
    // 太多就留最后 120 条、总量 8000 字，够写出具体细节又不撑爆上下文
    let excerpts = rows.slice(-120);
    let total = 0;
    const kept = [];
    for (let i = excerpts.length - 1; i >= 0; i -= 1) {
      const line = String(excerpts[i].text || "").trim();
      if (!line) continue;
      if (total + line.length > 8000) break;
      total += line.length;
      kept.unshift({ role: excerpts[i].role, text: clip(line, 400) });
    }
    return {
      letter,
      stageIndex: index,
      stageLabel: this.policy.labels[letter.stage] || letter.stage,
      tone: this.policy.temper?.[letter.stage] || "",
      isLast: letter.stage === this.policy.lastStage,
      wordTarget: letter.word_target || (letter.stage === this.policy.lastStage ? 3000 : 1500),
      since,
      until,
      previousStage: prevStage,
      excerpts: kept,
    };
  }

  /** 模型写好后回填。太短的判定为失败，保留模板正文。 */
  applyComposed(id, { body, model } = {}) {
    const text = String(body || "").trim();
    if (text.length < 300) throw new Error("生成的信太短，保留模板正文。");
    this.db
      .prepare("UPDATE letters SET body=?,status='ready',model=?,updated_at=? WHERE id=? AND character_id=?")
      .run(text, model || null, this.clock(), id, this.characterId);
    this.invalidate();
    return this.db.prepare("SELECT * FROM letters WHERE id=?").get(id);
  }

  listLetters() {
    this.initialize();
    const order = this.policy.order;
    return this.db
      .prepare("SELECT * FROM letters WHERE character_id=?")
      .all(this.characterId)
      .map((r) => {
        // 最后一封（情书）在读过之前只给壳，正文不出库
        const locked = r.stage === this.policy.lastStage && !r.unlocked_at;
        return {
          ...r,
          body: locked ? null : r.body,
          label: this.policy.labels[r.stage] || r.stage,
          unread: !r.read_at,
          locked,
        };
      })
      .sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
  }

  /** 有未读就先给阶段最低的那一封；全读完给 null（调用方转去信匣）。 */
  nextUnread() {
    return this.listLetters().find((l) => !l.read_at) || null;
  }

  /** 拆封：只有确认过才让正文出来。 */
  unlockLetter(id) {
    this.initialize();
    this.db
      .prepare("UPDATE letters SET unlocked_at=? WHERE id=? AND unlocked_at IS NULL")
      .run(this.clock(), id);
    this.invalidate();
    return this.listLetters().find((l) => l.id === id) || null;
  }

  markRead(id) {
    this.db.prepare("UPDATE letters SET read_at=? WHERE id=? AND read_at IS NULL").run(this.clock(), id);
    this.invalidate();
    return this.state();
  }

  /** 升阶时留个记号：下一轮对话可以顺口提一句「给你写了封信」。 */
  markNotice(stage, at) {
    try {
      this.db.prepare("UPDATE bond_state SET notice_stage=?, notice_at=? WHERE singleton=1").run(String(stage), String(at || this.clock()));
      this.invalidate();
    } catch {}
  }

  /** 有没有还没说出口的升阶。超过 7 天就不再提。 */
  pendingNotice() {
    try {
      this.initialize();
      const row = this.row();
      if (!row || !row.notice_stage) return null;
      const age = Date.parse(this.clock()) - Date.parse(row.notice_at || "");
      if (!Number.isFinite(age) || age > 7 * 864e5) return null;
      return { stage: row.notice_stage, label: this.policy.labels[row.notice_stage] || row.notice_stage, at: row.notice_at || "" };
    } catch {
      return null;
    }
  }

  clearNotice() {
    try {
      this.db.prepare("UPDATE bond_state SET notice_stage=NULL, notice_at=NULL WHERE singleton=1").run();
      this.invalidate();
    } catch {}
  }

  log({ event, from, to, points, messages, detail }) {
    try {
      this.db
        .prepare("INSERT INTO bond_log(at,event,from_stage,to_stage,points,messages,detail) VALUES (?,?,?,?,?,?,?)")
        .run(this.clock(), event, from || null, to || null, points | 0, messages | 0, detail || null);
    } catch {}
  }

  /** 调试用：凭空加 n 条消息，跳过等待。 */
  debugBump(n = 30) {
    this.initialize();
    const count = Math.max(0, Math.min(5000, n | 0));
    const at = this.clock();
    const out = { steps: 0, promotions: [], letters: [] };
    this.atomic(() => {
      for (let i = 0; i < count; i += 1) {
        const r = this.record({ role: i % 2 ? "assistant" : "user", occurredAt: at });
        out.steps += 1;
        if (r.promotions?.length) out.promotions.push(...r.promotions);
      }
    });
    // 调试推演里 assistant 会把刚留的提示清掉，末尾按最后一次升阶补回来
    if (out.promotions.length) {
      const last = out.promotions[out.promotions.length - 1];
      this.markNotice(last.to, at);
    }
    out.letters = this.listLetters();
    this.invalidate();
    return { ...this.state(), ...out };
  }

  debugReset() {
    this.initialize();
    this.db.prepare("UPDATE bond_state SET points=0,stage='acquainted',stage_messages=0,stage_started_at='',last_day=NULL,replayed=0,updated_at=? WHERE singleton=1").run(this.clock());
    this.db.prepare("DELETE FROM letters WHERE character_id=?").run(this.characterId);
    this.invalidate();
    return this.state();
  }
}

module.exports = { Bond, POLICY, TEMPLATES, ORDER, clip };
