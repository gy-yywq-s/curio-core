import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { DatabaseFiles } from "../src/server/supabase-store.mjs";
import { ContentStore, parseEntrySource } from "../src/server/content-store.mjs";

async function fixture() {
  const db = new PGlite();
  await db.exec(`create schema curio_private;
    create table curio_private.documents(namespace text, path text, body bytea, object_key text,
    modified_at timestamptz default now(), primary key(namespace,path),
    check ((body is null) <> (object_key is null)));`);
  const sql = async (strings, ...values) => (await db.query(strings.reduce((s, part, i) => s + (i ? `$${i}` : "") + part, ""), values)).rows;
  const objects = new Map();
  const objectStore = { async put(bytes) { const key = String(objects.size); objects.set(key, bytes); return key; }, async get(key) { return objects.get(key); } };
  const makeStore = namespace => new ContentStore("/curio", new DatabaseFiles(sql, namespace, objectStore));
  return { db, makeStore, objects };
}

test("database storage survives fresh instances, isolates environments, and preserves Markdown/media/history", async () => {
  const { db, makeStore } = await fixture();
  try {
    const store = makeStore("dev");
    const batch = await store.inspectUpload([
      { name: "folder/entry.md", bytes: Buffer.from("---\ntitle: SQL entry\nstatus: published\n---\nHello ![pixel](pixel.png)") },
      { name: "folder/pixel.png", bytes: Buffer.from([1, 2, 3]) },
    ]);
    const [saved] = await store.commitBatch(batch.batchId, [{ itemId: batch.items[0].itemId, action: "new" }]);
    const fresh = makeStore("dev");
    assert.match((await fresh.getRecord(saved.lineageId, { includeBody: true })).body, /Hello/);
    assert.deepEqual(await fresh.fs.readFile(`/curio/media/${saved.lineageId}/folder/pixel.png`), Buffer.from([1, 2, 3]));
    assert.equal((await fresh.history()).length, 1);
    assert.deepEqual(await fresh.listStagedBatches(), []);
    assert.deepEqual(await makeStore("production").listRecords(), []);
    await fresh.updateEntry(saved.lineageId, { body: "Revised body", status: "draft" });
    assert.equal((await fresh.history()).length, 2);
    assert.equal((await fresh.listRecords({ includeDrafts: false })).length, 0);
    const event = (await fresh.history())[0];
    assert.ok((await fresh.historyDetail(event.eventId)).diff.length);
  } finally { await db.close(); }
});

test("failed batch transaction leaves no partial entry, revision or history", async () => {
  const { db, makeStore } = await fixture();
  try {
    const store = makeStore("dev");
    store.initialize = async () => {};
    const batch = await store.inspectUpload([{ name: "entry.md", bytes: Buffer.from("# First\n\nBody") }]);
    await db.exec("begin");
    await assert.rejects(store.commitBatch(batch.batchId, [
      { itemId: batch.items[0].itemId, action: "new" },
      { itemId: "missing-item", action: "new" },
    ]), /no longer available/);
    await db.exec("rollback");
    assert.deepEqual(await store.listRecords(), []);
    assert.deepEqual(await store.history(), []);
    assert.ok(await store.readManifest(batch.batchId));
  } finally { await db.close(); }
});

test("replacing media preserves old objects for history and transaction rollback", async () => {
  const { db, makeStore, objects } = await fixture();
  try {
    const files = makeStore("dev").fs;
    await files.writeFile("/curio/media/image.png", Buffer.from("before"));
    await db.exec("begin");
    await files.writeFile("/curio/media/image.png", Buffer.from("after"));
    await db.exec("rollback");
    // Each transaction gets a fresh adapter in production; caches never outlive it.
    assert.equal((await makeStore("dev").fs.readFile("/curio/media/image.png")).toString(), "before");
    assert.equal(objects.size, 2);
    const store = makeStore("dev");
    await store.applyEntry(parseEntrySource("# An entry\n\ntext", "entry.md"));
    assert.equal((await store.listRecords()).length, 1);
  } finally { await db.close(); }
});
