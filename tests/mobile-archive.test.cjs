"use strict";

// mobile-archive.cjs：.ellenpack 容器的读写与落到电脑端聊天记录。
// 造合规样例包（v1/v2），做往返、篡改、端到端导入的验证。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const A = require("../src/mobile-archive.cjs");

const iso = (s) => new Date(s).toISOString();
const T0 = iso("2026-10-28T13:00:00.000Z");

function attach(id, kind, value, at, extra) {
  return {
    id,
    revisionId: `${id}-r1`,
    parents: [],
    at,
    kind,
    profileId: "profile-1",
    deleted: false,
    refs: [],
    value,
    ...extra,
  };
}

function snapshot() {
  return {
    schemaVersion: 1,
    profiles: [{ id: "profile-1", characterId: "ellen", createdAt: T0 }],
    records: [
      attach("thread-a", "thread", { title: "第一次见面", createdAt: iso("2026-10-01T10:00:00.000Z") }, iso("2026-10-01T10:00:00.000Z")),
      attach("msg-a1", "message", { threadId: "thread-a", role: "user", status: "completed", text: "在吗", createdAt: iso("2026-10-01T10:01:00.000Z") }, iso("2026-10-01T10:01:00.000Z")),
      attach("msg-a2", "message", { threadId: "thread-a", role: "assistant", status: "completed", text: "我在。", createdAt: iso("2026-10-01T10:01:30.000Z") }, iso("2026-10-01T10:01:30.000Z")),
      attach("thread-b", "thread", { title: "深夜", createdAt: iso("2026-10-02T23:00:00.000Z") }, iso("2026-10-02T23:00:00.000Z")),
      attach("msg-b1", "message", { threadId: "thread-b", role: "user", status: "completed", text: "睡不着", createdAt: iso("2026-10-02T23:05:00.000Z") }, iso("2026-10-02T23:05:00.000Z")),
      attach("mem-1", "memory", { text: "他喜欢下雨天", createdAt: iso("2026-10-02T23:10:00.000Z") }, iso("2026-10-02T23:10:00.000Z")),
      // 被取代的旧修订：不应出现在展开结果里
      {
        ...attach("msg-a1", "message", { threadId: "thread-a", role: "user", status: "completed", text: "在吗?", createdAt: iso("2026-10-01T10:01:00.000Z") }, iso("2026-10-01T10:01:00.000Z")),
        revisionId: "msg-a1-r2",
        parents: ["msg-a1-r1"],
      },
    ],
  };
}

function packageContent(snap) {
  return {
    format: A.TRANSFER,
    formatVersion: 1,
    packageId: "package-test-1",
    origin: { deviceId: "device-a", platform: "android" },
    exportedAt: T0,
    snapshot: snap,
    media: { mode: "metadata-only", requiredIds: [] },
  };
}

function manifestV1(snap, files) {
  const content = packageContent(snap);
  return {
    format: A.FORMAT,
    version: 1,
    package: { content, checksum: `sha256:${A.sha256Text(A.canonicalJsonStrict(content))}` },
    files: files || [],
  };
}

function fakeStore() {
  const threads = [];
  const msgs = new Map();
  let n = 0;
  return {
    createConversation(title) {
      const t = { id: `local-${++n}`, title };
      threads.push(t);
      msgs.set(t.id, []);
      return t;
    },
    put(id, msg) {
      msgs.get(id).push(msg);
    },
    list() {
      return threads;
    },
    dump() {
      return threads.map((t) => ({ title: t.title, messages: msgs.get(t.id) }));
    },
  };
}

function tempDir(prefix) {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  } catch {
    const dir = path.join(process.cwd(), "_临时", `${prefix}${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

test("规范化 JSON：键排序、数组保序、非法值拒绝", () => {
  assert.strictEqual(A.canonicalJson({ b: 1, a: [2, { z: 1, y: 2 }] }), '{"a":[2,{"y":2,"z":1}],"b":1}');
  assert.strictEqual(A.canonicalJson(null), "null");
  assert.strictEqual(A.canonicalJson("x"), '"x"');
  assert.throws(() => A.canonicalJsonStrict({ a: NaN }), (e) => e.code === "INVALID_JSON");
  assert.throws(() => A.canonicalJsonStrict({ constructor: 1 }), (e) => e.code === "INVALID_JSON");
});

test("v1 清单严格校验通过且无警告", async () => {
  const checked = await A.validateManifest(manifestV1(snapshot()));
  assert.strictEqual(checked.version, 1);
  assert.strictEqual(checked.isSelectionBackup, false);
  assert.deepStrictEqual(checked.warnings, []);
});

test("容器往返：无媒体 / 带媒体块 / 尾字节", async () => {
  const manifest = manifestV1(snapshot());
  const buf = A.writeArchive({ manifest, files: [] });
  assert.strictEqual(buf.subarray(0, 9).toString("ascii"), "ELLENPK1\n");
  const parsed = await A.parseArchiveBuffer(buf);
  assert.strictEqual(parsed.version, 1);
  assert.strictEqual(parsed.trailingBytes, 0);
  assert.deepStrictEqual(parsed.warnings, []);

  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
  const item = { id: "file-1", sha256: A.sha256Hex(data), sizeBytes: data.length, mimeType: "image/png" };
  const buf2 = A.writeArchive({ manifest: { ...manifest, files: [item] }, files: [{ ...item, data }] });
  const parsed2 = await A.parseArchiveBuffer(buf2);
  assert.strictEqual(parsed2.files.length, 1);
  assert.ok(parsed2.files[0].data.equals(data));
  assert.strictEqual(parsed2.trailingBytes, 0);
});

test("快照展开：旧修订被取代，冲突可识别", () => {
  const records = A.expandRecords(snapshot());
  const a1 = records.find((r) => r.id === "msg-a1");
  assert.strictEqual(a1.revisionId, "msg-a1-r2");
  assert.strictEqual(a1.value.text, "在吗?");
  assert.strictEqual(records.filter((r) => r.kind === "message").length, 3);
  assert.strictEqual(A.summarizeSnapshot(snapshot()).byKind.memory, 1);
});

test("转 chat-export：按更新时间倒序，Markdown 可读", () => {
  const payload = A.toChatExport(snapshot(), { character: { name: "艾莲" } });
  assert.strictEqual(payload.format, "ellen-chat-export");
  assert.strictEqual(payload.conversations.length, 2);
  assert.strictEqual(payload.conversations[0].title, "深夜");
  const ca = payload.conversations.find((c) => c.title === "第一次见面");
  assert.strictEqual(ca.messages.length, 2);
  assert.strictEqual(ca.messages[0].text, "在吗?");
  assert.strictEqual(ca.messages[1].role, "assistant");
  const md = A.buildMarkdown(payload);
  assert.ok(md.startsWith("# 艾莲 · 聊天记录"));
  assert.ok(md.includes("## 深夜"));
  assert.ok(md.includes("**你**") && md.includes("**艾莲**"));
});

test("负例：坏 magic / 截断 / 摘要不符 / 版本不符", async () => {
  const manifest = manifestV1(snapshot());
  const buf = A.writeArchive({ manifest, files: [] });

  const badMagic = Buffer.from(buf);
  badMagic[0] = 0x41;
  await assert.rejects(() => A.parseArchiveBuffer(badMagic), (e) => e.code === "INVALID_ARCHIVE");
  await assert.rejects(() => A.parseArchiveBuffer(buf.subarray(0, 20)), (e) => e.code === "INVALID_ARCHIVE_CHUNK");

  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.package.content.snapshot.records[0].value.title = "改过";
  const warned = await A.validateManifest(tampered);
  assert.ok(warned.warnings.some((w) => w.code === "CHECKSUM_MISMATCH"));

  await assert.rejects(() => A.validateManifest({ ...manifest, version: 3 }), (e) => e.code === "INVALID_ARCHIVE_MANIFEST");
  await assert.rejects(() => A.validateManifest({ ...manifest, format: "other" }), (e) => e.code === "INVALID_ARCHIVE_MANIFEST");
});

test("v2 分类备份：顶层 checksum 校验", async () => {
  const base = { format: A.FORMAT, version: 2, package: manifestV1(snapshot()).package, files: [], selection: null, groupId: null };
  const ok = { ...base, checksum: A.sha256Text(A.canonicalJsonStrict(base)) };
  const checked = await A.validateManifest(ok);
  assert.strictEqual(checked.isSelectionBackup, true);
  assert.deepStrictEqual(checked.warnings, []);

  const bad = await A.validateManifest({ ...ok, checksum: "f".repeat(64) });
  assert.ok(bad.warnings.some((w) => w.code === "CHECKSUM_MISMATCH"));
});

test("端到端：文件 → importMobileArchive → 写进 store", async () => {
  const dir = tempDir("ellenpack-");
  try {
    const file = path.join(dir, "艾莲相处资料-2026-10-28.ellenpack");
    fs.writeFileSync(file, A.writeArchive({ manifest: manifestV1(snapshot()), files: [] }));

    const preview = await A.previewMobileArchive({ filePath: file });
    assert.strictEqual(preview.version, 1);
    assert.strictEqual(preview.summary.byKind.thread, 2);
    assert.strictEqual(preview.chats.length, 2);
    assert.deepStrictEqual(preview.warnings, []);

    const store = fakeStore();
    const res = await A.importMobileArchive({ store, character: { name: "艾莲" }, filePath: file });
    assert.strictEqual(res.conversations, 2);
    assert.strictEqual(res.messages, 3);
    assert.strictEqual(res.skipped, 0);
    assert.deepStrictEqual(res.warnings, []);

    const dump = store.dump();
    assert.strictEqual(dump.length, 2);
    assert.strictEqual(dump.reduce((n, t) => n + t.messages.length, 0), 3);
    assert.ok(dump.every((t) => t.messages.every((m) => m.status === "completed" && typeof m.id === "string")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("端到端：坏包与假文件都不写入任何记录", async () => {
  const dir = tempDir("ellenpack-bad-");
  try {
    const manifest = manifestV1(snapshot());
    manifest.package.checksum = `sha256:${"0".repeat(64)}`;
    const bad = path.join(dir, "bad.ellenpack");
    fs.writeFileSync(bad, A.writeArchive({ manifest, files: [] }));

    const store = fakeStore();
    await assert.rejects(() => A.importMobileArchive({ store, filePath: bad }), (e) => e.code === "CHECKSUM_MISMATCH");
    assert.strictEqual(store.dump().length, 0);

    const junk = path.join(dir, "junk.ellenpack");
    fs.writeFileSync(junk, Buffer.from("hello world, not an archive"));
    await assert.rejects(
      () => A.importMobileArchive({ store: fakeStore(), filePath: junk }),
      (e) => e.code === "INVALID_ARCHIVE"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
