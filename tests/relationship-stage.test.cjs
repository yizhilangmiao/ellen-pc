"use strict";
// 好感度阶段 + 人格流程测试：朋友→恋人的门槛、角色包可覆盖的接口、
// 以及「人格指导按角色包读文件」这条数据驱动路径。
// 门槛判定错，用户会在相识阶段被当成恋人；读文件读宽了，一句 ../ 就能读到工程外。
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const POLICY = require(path.join(__dirname, "..", "memory", "src", "relationship-policy.cjs"));
const DG = require(path.join(__dirname, "..", "src", "dialogue-guidance.cjs"));

/** 一份刚好满足某阶段门槛的数值，按需覆盖。 */
function dims(over = {}) {
  return Object.assign({ familiarity: 0, trust: 0, closeness: 0 }, over);
}

function state(over = {}) {
  return Object.assign(
    { dimensions: dims(), meaningfulEvents: 0, evidenceDays: 0, assessedEvents: 1 },
    over
  );
}

test("未评估过关系时不报阶段，只报「正在积累」", () => {
  const fresh = POLICY.stage(state({ assessedEvents: 0, legacyEvents: 0 }));
  assert.equal(fresh.key, "unassessed");
  assert.equal(fresh.label, "陌生");

  const carrying = POLICY.stage(state({ assessedEvents: 0, legacyEvents: 40 }));
  assert.equal(carrying.key, "unassessed");
  assert.match(carrying.label, /积累/);
});

test("什么都不够时是陌生", () => {
  assert.equal(POLICY.stage(state()).key, "learning");
});

test("熟悉度、事件数、天数同时到位才进相识", () => {
  const ok = POLICY.stage(state({ dimensions: dims({ familiarity: 3 }), meaningfulEvents: 2 }));
  assert.equal(ok.key, "acquainted");

  const notEnoughDays = POLICY.stage(
    state({ dimensions: dims({ familiarity: 12 }), meaningfulEvents: 6, evidenceDays: 2 })
  );
  assert.equal(notEnoughDays.key, "acquainted", "天数不够，不能跳级");
});

test("信赖需要信任轴，只有熟悉度不行", () => {
  const noTrust = POLICY.stage(
    state({ dimensions: dims({ familiarity: 30 }), meaningfulEvents: 20, evidenceDays: 8 })
  );
  assert.equal(noTrust.key, "familiar");

  const withTrust = POLICY.stage(
    state({ dimensions: dims({ familiarity: 30, trust: 22 }), meaningfulEvents: 20, evidenceDays: 8 })
  );
  assert.equal(withTrust.key, "trusted");
});

test("亲近需要三轴齐备", () => {
  const gate = POLICY.POLICY.stageGates.close;
  const s = POLICY.stage(
    state({
      dimensions: dims({ familiarity: gate.familiarity, trust: gate.trust, closeness: gate.closeness }),
      meaningfulEvents: gate.events,
      evidenceDays: gate.days,
    })
  );
  assert.equal(s.key, "close");
});

test("恋人档：数值够了但没有 romance 就停在亲近", () => {
  const gate = POLICY.POLICY.stageGates.lover;
  const s = state({
    dimensions: dims({ familiarity: gate.familiarity, trust: gate.trust, closeness: gate.closeness }),
    meaningfulEvents: gate.events,
    evidenceDays: gate.days,
  });
  assert.equal(POLICY.stage(s).key, "close");
  assert.equal(POLICY.stage(s, { romance: true }).key, "lover");
});

test("角色包可以用 stageGates 只覆盖想改的那一档", () => {
  const s = state({
    dimensions: dims({ familiarity: 10, trust: 5, closeness: 5 }),
    meaningfulEvents: 1,
    evidenceDays: 0,
  });
  assert.equal(POLICY.stage(s, { romance: true }).key, "learning", "默认门槛下连相识都进不去");

  const over = POLICY.stage(s, {
    romance: true,
    stageGates: { lover: { familiarity: 10, trust: 5, closeness: 5, events: 1, days: 0 } },
  });
  assert.equal(over.key, "lover", "覆盖只改恋人档，其余沿用默认");
});

test("关系被伤到负值就直接进「有待修复」，压过一切高级阶段", () => {
  const gate = POLICY.POLICY.stageGates.lover;
  const s = state({
    dimensions: dims({ familiarity: gate.familiarity, trust: -10, closeness: gate.closeness }),
    meaningfulEvents: gate.events,
    evidenceDays: gate.days,
  });
  assert.equal(POLICY.stage(s, { romance: true }).key, "strained");
});

test("六个阶段都在行为说明表里，恋人档有专属提示", () => {
  for (const k of ["learning", "acquainted", "familiar", "trusted", "close", "lover", "strained"]) {
    assert.ok(DG.STAGES[k], "缺阶段说明：" + k);
    assert.equal(DG.STAGES[k].length, 2, "每个阶段要有「名字 + 一句行为」");
  }
  assert.equal(DG.STAGES.lover[0], "恋人");
});

test("人格指导按角色包读文件：中文文件名能读、内容进 prompt", () => {
  const text = DG.readGuidance("_模板", "当轮接话.md");
  assert.ok(text && text.length > 50, "模板卡的当轮接话.md 应该能读到");

  const out = DG.buildDialogueGuidance({
    state: { characterId: "_模板", guidance: "当轮接话.md" },
    messages: [],
  });
  assert.ok(out.includes("人格流程"), "读到的文件内容要真的进 prompt");
});

test("没有 guidance 声明的角色走通用节奏兜底，不是空 prompt", () => {
  const out = DG.buildDialogueGuidance({
    state: { characterId: "_模板", guidance: null },
    messages: [],
  });
  assert.ok(out.includes("本轮接话方式"));
  assert.ok(out.length > 100);
});

test("人格指导读不到文件时不炸，只有干净返回", () => {
  assert.equal(DG.readGuidance("_模板", "不存在的文件.md"), null);
  assert.equal(DG.readGuidance("_模板", null), null);
});

test("人格指导不许跳出角色目录", () => {
  assert.equal(DG.readGuidance("ellen", "../../secret.md"), null);
  assert.equal(DG.readGuidance("..", "当轮接话.md"), null);
  assert.equal(DG.readGuidance("ellen", "a/b.md"), null);
  assert.equal(DG.readGuidance(".git", "config"), null);
});

test("恋人档的说明只在恋人阶段出现，不提前剧透", () => {
  const base = {
    characterId: "_模板",
    guidance: null,
    romance: true,
    relationship: {
      stage: { key: "close" },
      dimensions: dims({ familiarity: 45, trust: 40, closeness: 35 }),
      meaningfulEvents: 30,
      evidenceDays: 14,
    },
  };
  const atClose = DG.buildDialogueGuidance({ state: base, messages: [] });
  assert.ok(!atClose.includes("双方已经是恋人"));

  const atLover = DG.buildDialogueGuidance({
    state: Object.assign({}, base, { relationship: Object.assign({}, base.relationship, { stage: { key: "lover" } }) }),
    messages: [],
  });
  assert.ok(atLover.includes("双方已经是恋人"));
});
