/**
 * 信件 MVP（测试版）
 * 看点数、收信、读信、信匣回看、切下一封。
 * 正文交给模型写（模板只是兜底）。拖拽、收侧栏、动画还没做。
 */
(() => {
  "use strict";

  const invoke = (req) => window.companion.invoke("letters", req);
  const ENVELOPE =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="5.5" width="19" height="13" rx="2.2"/><path d="M3 7l9 6 9-6"/></svg>';
  const MIN_READY = 300; // 少于这个字数当没写完，重新让模型写
  const ORDER = ["acquainted", "familiar", "trusted", "close", "lover"];

  let state = null;
  let current = null;
  let pendingIds = [];
  let timer = null;
  let composing = null;
  let view = "letter"; // letter | archive
  let skipOpening = false;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  // ---- 骨架 ----
  // 入口优先用聊天工具条里的按钮；没有它再退回右下浮动信封
  const entries = [...document.querySelectorAll('[data-action="letters"]')];
  const archiveEntries = [...document.querySelectorAll('[data-action="letters-archive"]')];
  let fab = entries[0] || null;
  const inlineEntry = !!fab;
  if (!fab) {
    fab = el("button", "letter-fab");
    fab.innerHTML = ENVELOPE;
  }
  fab.type = "button";
  fab.title = "她留给你的信";
  let badge = fab.querySelector(".letter-fab-badge");
  if (!badge) {
    badge = el("span", "letter-fab-badge");
    fab.appendChild(badge);
  }
  badge.hidden = true;

  const layer = el("div", "letter-layer");
  const card = el("div", "letter-card");
  const head = el("div", "letter-card-head");
  const headTitle = el("h2", "letter-card-title", "艾莲的信");
  const stageTag = el("span", "letter-card-stage", "—");
  const closeBtn = el("button", "letter-card-close", "×");
  closeBtn.type = "button";
  head.append(headTitle, stageTag, closeBtn);

  const body = el("div", "letter-body");
  const archive = el("div", "letter-archive");
  archive.hidden = true;

  const foot = el("div", "letter-foot");
  const hint = el("span", "letter-hint");
  const nextBtn = el("button", "letter-btn", "下一封");
  nextBtn.type = "button";
  nextBtn.hidden = true;
  const archiveBtn = el("button", "letter-btn", "信匣");
  archiveBtn.type = "button";
  foot.append(hint, nextBtn, archiveBtn);

  const bow = el("div", "letter-bow");
  bow.innerHTML =
    '<svg viewBox="0 0 60 44" aria-hidden="true"><path d="m25 18-9 22 9-3 4 6 4-24m1-1 6 23 4-8 8 2-12-20" fill="#d6a0b4" stroke="#efc5d6" stroke-width="1.2"/><path d="M27 14C17 2 5 2 4 8L7 25q3 6 20-5m7-6C45 3 56 3 56 10l-3 16q-4 5-19-6" fill="#e4b2c9" stroke="#f0c8db" stroke-width="1.2"/><path d="m25 14-13-4m14 8-14 4m23-7 13-5m-13 9 12 4" fill="none" stroke="#b77d99" stroke-width="1.3"/><rect x="25" y="12" width="11" height="12" rx="3" fill="#d49bb8" stroke="#f0c8db"/></svg>';
  card.append(head, body, archive, foot, bow);
  layer.appendChild(card);
  if (!inlineEntry) document.body.appendChild(fab);
  document.body.appendChild(layer);

  // ---- 渲染：正文 ----
  function isReady(letter) {
    return !!letter && letter.status === "ready" && String(letter.body || "").length >= MIN_READY;
  }

  function setView(next) {
    view = next;
    body.hidden = next !== "letter";
    archive.hidden = next !== "archive";
    archiveBtn.textContent = next === "archive" ? "返回" : "信匣";
    if (next === "archive") {
      headTitle.textContent = "信匣";
      nextBtn.hidden = true;
    } else if (current) {
      headTitle.textContent = "艾莲的信";
    }
  }

  function paintEmpty() {
    body.replaceChildren(el("div", "letter-empty", "还没有信。等她攒够话，会写给你的。"));
    stageTag.textContent = "—";
    headTitle.textContent = "艾莲的信";
    nextBtn.hidden = true;
    archiveBtn.hidden = true;
  }

  function paintLetter(letter) {
    if (!letter) return paintEmpty();
    current = letter;
    setView("letter");
    headTitle.textContent = "艾莲的信";
    stageTag.textContent = letter.label || "—";
    const title = el("div", "letter-title", letter.title);
    const text = el("div", "letter-text", letter.body || "");
    const sign = el("div", "letter-sign", letter.signature);
    body.replaceChildren(title, text, sign);
    body.scrollTop = 0;
    if (!isReady(letter)) {
      text.classList.add("letter-text-draft");
      hint.textContent = "这是底稿，正在请她重写…";
    } else {
      hint.textContent = "";
    }
    const rest = pendingIds.filter((id) => id !== letter.id).length;
    nextBtn.hidden = rest === 0;
    nextBtn.textContent = rest > 0 ? `还有 ${rest} 封` : "下一封";
    archiveBtn.hidden = false;
  }

  function paintWriting(letter) {
    headTitle.textContent = "艾莲的信";
    stageTag.textContent = letter.label || "—";
    const title = el("div", "letter-title", letter.title);
    const wait = el("div", "letter-writing");
    wait.append(
      el("span", "letter-writing-dot", ""),
      el("span", "letter-writing-dot", ""),
      el("span", "letter-writing-dot", "")
    );
    wait.append(el("span", "letter-writing-text", "她正在写…"));
    body.replaceChildren(title, wait);
    body.scrollTop = 0;
    nextBtn.hidden = true;
    archiveBtn.hidden = true;
    hint.textContent = "";
  }

  // ---- 渲染：信匣 ----
  function paintArchive(letters) {
    setView("archive");
    stageTag.textContent = `${letters.length} 封`;
    archive.textContent = "";
    if (!letters.length) {
      archive.appendChild(el("div", "letter-empty", "信匣还是空的。"));
      archiveBtn.hidden = false;
      return;
    }
    for (const stageKey of ORDER) {
      const group = letters.filter((l) => l.stage === stageKey);
      if (!group.length) continue;
      const box = el("div", "letter-group");
      box.appendChild(el("div", "letter-group-title", group[0].label || stageKey));
      for (const letter of group) {
        const item = el("button", "letter-item");
        item.type = "button";
        item.dataset.unread = letter.read_at ? "0" : "1";
        const ready = isReady(letter);
        const left = el("div", "letter-item-main");
        left.append(
          el("span", "letter-item-title", letter.title || "（无题）"),
          el(
            "span",
            "letter-item-meta",
            `${String(letter.created_at || "").slice(0, 10)} · ${ready ? `${String(letter.body || "").replace(/\s/g, "").length} 字` : "待重写"}`
          )
        );
        item.appendChild(left);
        if (!ready) item.appendChild(el("span", "letter-item-flag", "底稿"));
        item.onclick = () => openLetter(letter.id);
        box.appendChild(item);
      }
      archive.appendChild(box);
    }
    archiveBtn.hidden = false;
    hint.textContent = "";
    archive.scrollTop = 0;
  }

  /** 正文不是模型写的就现场写完再显示。失败保留底稿并说明原因。 */
  async function ensureBody(letter) {
    if (!letter || isReady(letter)) return letter;
    if (composing === letter.id) return null;
    composing = letter.id;
    paintWriting(letter);
    try {
      const done = await invoke({ type: "compose", id: letter.id });
      if (current?.id === letter.id) paintLetter(done);
      return done;
    } catch (error) {
      console.warn("[letters] 写信失败", error);
      if (current?.id === letter.id) {
        paintLetter(letter);
        hint.textContent = "这次没写成：" + (error?.message || error);
      }
      return null;
    } finally {
      composing = null;
    }
  }

  function paintBadge() {
    const n = state?.unread || 0;
    const text = n > 9 ? "9+" : String(n);
    for (const node of document.querySelectorAll(".letter-fab-badge")) {
      node.hidden = n === 0;
      node.textContent = text;
    }
    for (const node of entries) node.dataset.empty = n === 0 ? "1" : "0";
  }

  // ---- 取数 ----
  async function refresh() {
    try {
      state = await invoke({ type: "state" });
      paintBadge();
      if (view === "archive" && layer.dataset.open === "1") {
        const all = await invoke({ type: "list" });
        paintArchive(all);
      }
    } catch (error) {
      fab.title = "信件未就绪：" + (error?.message || error);
      if (window.__lettersDebug) console.warn("[letters]", error);
    }
  }

  // ---- 开卡：信纸从卡口抽出来（文本展开，不做无关装饰） ----
  const reducedMotion = () =>
    document.body.classList.contains("reduce-ui-motion") ||
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  function playOpening() {
    if (skipOpening) {
      skipOpening = false;
      return;
    }
    if (reducedMotion()) return;
    card.removeAttribute("data-enter");
    void card.offsetWidth; // 强制回流，连点时能重播
    card.setAttribute("data-enter", "1");
    const ribbon = el("div", "letter-ribbon");
    card.appendChild(ribbon);
    setTimeout(() => ribbon.remove(), 620);
    setTimeout(() => card.removeAttribute("data-enter"), 760);
  }

  /** 统一分发：锁着的先给封面，不直接把正文摊开 */
  function show(letter) {
    if (!letter) return paintEmpty();
    if (letter.locked) return paintLocked(letter);
    paintLetter(letter);
    ensureBody(letter);
  }

  function paintLocked(info) {
    current = null;
    setView("letter");
    headTitle.textContent = "艾莲的信";
    stageTag.textContent = info.label || "最后一封";
    const box = el("div", "letter-locked");
    const seal = el("div", "letter-locked-seal", "封");
    const title = el("div", "letter-locked-title", "这一封，她写得很慢");
    const desc = el("div", "letter-locked-desc", "她说要把最重要的话放在这里。旁人看到也没关系吗？");
    const row = el("div", "letter-locked-actions");
    const go = el("button", "letter-btn letter-btn-primary", "现在就看");
    go.type = "button";
    go.onclick = () => unlockAndShow(info.id);
    const later = el("button", "letter-btn", "先放着");
    later.type = "button";
    later.onclick = () => close();
    row.append(go, later);
    box.append(seal, title, desc, row);
    body.replaceChildren(box);
    body.scrollTop = 0;
    nextBtn.hidden = true;
    archiveBtn.hidden = false;
    hint.textContent = "";
  }

  async function unlockAndShow(id) {
    if (composing === id) return;
    composing = id;
    hint.textContent = "";
    try {
      const letter = await invoke({ type: "unlock", id });
      paintLetter(letter);
      ensureBody(letter);
      await refresh();
    } catch (error) {
      hint.textContent = error?.message || String(error);
    } finally {
      composing = null;
    }
  }

  async function openLetter(id) {
    playOpening(); // 每封信都播
    skipOpening = false;
    const read = await invoke({ type: "read", id });
    if (read && read.locked) {
      paintLocked(read.letter);
      await refresh();
      return;
    }
    paintLetter(read);
    await refresh();
    ensureBody(read);
  }

  async function open(markLowest = true, animate = true) {
    layer.dataset.open = "1";
    if (!animate) skipOpening = true;
    try {
      const all = await invoke({ type: "list" });
      pendingIds = all.filter((l) => l.unread).map((l) => l.id);
      if (!markLowest) {
        const last = all[all.length - 1] || null;
        playOpening(); // 直接取最后一封也播
        show(last);
        return;
      }
      const lowest = all.find((l) => l.unread);
      const target = lowest || all[all.length - 1] || null;
      if (target) await openLetter(target.id);
      else paintEmpty();
    } catch (error) {
      console.warn("[letters] 打开失败", error);
      body.hidden = false;
      body.replaceChildren(el("div", "letter-empty", "没打开：" + (error?.message || error)));
      nextBtn.hidden = true;
      archiveBtn.hidden = true;
    }
  }

  function bindEntries() {
    for (const node of entries) {
      node.addEventListener("click", () => open(true));
    }
    for (const node of archiveEntries) {
      node.addEventListener("click", async () => {
        await open(true);
        setView("archive");
      });
    }
  }

  function close() {
    layer.dataset.open = "0";
  }

  // ---- 事件 ----
  fab.addEventListener("click", () => open(true));
  closeBtn.addEventListener("click", close);
  layer.addEventListener("click", (e) => {
    if (e.target === layer) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && layer.dataset.open === "1") {
      if (view === "archive" && current) paintLetter(current);
      else close();
    }
  });
  nextBtn.addEventListener("click", async () => {
    const nextId = pendingIds.find((id) => id !== current?.id);
    if (!nextId) return close();
    await openLetter(nextId);
  });
  archiveBtn.addEventListener("click", async () => {
    if (view === "archive") {
      if (current) paintLetter(current);
      else setView("letter");
      return;
    }
    try {
      const all = await invoke({ type: "list" });
      paintArchive(all);
    } catch (error) {
      hint.textContent = "信匣打不开：" + (error?.message || error);
    }
  });

  // ---- 启动 ----
  bindEntries();
  refresh();
  timer = setInterval(refresh, 5000);
  window.addEventListener("beforeunload", () => clearInterval(timer));

  window.__ellenLetters = { open, close, refresh, archive: () => archiveBtn.click(), get state() { return state; } };
})();
