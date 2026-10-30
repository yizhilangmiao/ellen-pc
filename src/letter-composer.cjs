"use strict";

/**
 * 把一封「占位信」交给模型写成正式正文。
 *
 * 分工：
 *   - memory/src/bond.cjs   只负责数点数、升阶、攒素材（letterContext）
 *   - 本文件                只负责拼提示词、调模型、清洗输出
 *   - src/letters-actions   只负责把两者接起来，并回填数据库
 *
 * 字数下限是硬要求：普通信 1500 字，情书 3000 字（policy.words）。
 */

const STAGE_ROLE = {
  acquainted: "刚认识她的朋友",
  familiar: "她的好朋友",
  trusted: "她信得过的人",
  close: "与她只差一句话的人",
  lover: "她的恋人",
};

const BANNED_TAIL = ["希望这封信", "祝好", "此致", "顺颂", "如上所述", "总之，", "作为AI", "作为 AI", "我是AI"];

function tidy(text) {
  let s = String(text || "");
  s = s.replace(/^\s*```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "");
  s = s.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  s = s.replace(/^#+\s*/gm, "");
  s = s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1");
  return s.trim();
}

function tooShort(text, target) {
  const n = String(text || "").replace(/\s/g, "").length;
  return { ok: n >= target, count: n };
}

function buildPrompt({ context, persona, characterName, signature }) {
  const target = context.wordTarget || 1500;
  const label = context.stageLabel || "相识";
  const tone = context.tone || "";
  const lines = context.excerpts
    .map((e) => `${e.role === "user" ? "她" : "我"}：${String(e.text || "").replace(/\n/g, " ")}`)
    .join("\n");

  const who = [characterName ? `你是${characterName}。` : "你就是这个角色本人。", persona ? String(persona).slice(0, 4000) : ""]
    .filter(Boolean)
    .join("\n");

  const system = [
    who,
    "",
    `现在你要给她写一封信，不是聊天，是手写的信。此刻你们的关系是「${label}」，你是${STAGE_ROLE[label] || "她的朋友"}。`,
    tone ? `这封信的底色：${tone}` : "",
    "",
    "写作要求：",
    `1. 全文不少于 ${target} 个汉字。这是硬下限，写不到就算失败，你要把细节铺开而不是重复抒情。`,
    "2. 必须落到具体的东西：这段时间她说过的原话、你们聊过的场景、时间、某件小事。禁止通篇空泛的抒情和排比。",
    "3. 第一人称，像真的在纸上写：可以有短句、停顿、说得不连贯的地方、突然跑题的念头。不要作文腔、不要总结陈词。",
    "4. 不要写标题，不要写「亲爱的」以外的抬头格式，不要解释你在做什么。",
    "5. 结尾另起一行，落款就用给定的那一句，不要改。",
    "6. 不出现「作为AI」「希望这封信能」「祝好」「此致」这类话。",
    "",
    characterName ? `落款：${signature || `——${characterName}`}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `【这段时间我们说过的话】${lines || "（还没有聊过什么，就写刚开始认识的感觉）"}`,
    `【落款】${signature || ""}`,
    `【字数下限】${target} 字（现在开始写，直接写正文）`,
  ].join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/**
 * @returns {Promise<{body:string, count:number, model:string|null}>}
 */
async function composeLetter({ gateway, context, persona, characterName, signature, maxAttempts = 2 }) {
  if (!gateway) throw new Error("模型通道还没准备好。");
  const target = context.wordTarget || 1500;
  const messages = buildPrompt({ context, persona, characterName, signature });
  const maxTokens = Math.min(16000, Math.max(4096, Math.round(target * 2.2)));

  let last = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const ask =
      attempt === 1
        ? messages
        : [
            messages[0],
            {
              role: "user",
              content:
                messages[1].content +
                `\n\n上次只写了 ${last.length} 字，不够。这次务必写到 ${target} 字以上，把细节展开，不要压缩。`,
            },
          ];
    const raw = await gateway.complete({ messages: ask, maxTokens, purpose: "letter" });
    const body = tidy(raw);
    const check = tooShort(body, target);
    if (check.ok) return { body, count: check.count, model: null };
    last = body;
  }

  // 两轮都不够：返回最长的那个，由上层决定留不留
  return { body: last, count: last.replace(/\s/g, "").length, model: null, short: true };
}

module.exports = { composeLetter, buildPrompt, tidy, tooShort, STAGE_ROLE, BANNED_TAIL };
