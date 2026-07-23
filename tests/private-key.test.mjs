import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentStore, parseEntrySource } from "../src/server/content-store.mjs";
import { keySummary, readKey, tokenFor, tokenOpens, tryAnswer, writeKey } from "../src/server/private-key.mjs";

test("the key opens with its answer, gives a cookie that a new answer turns away, and slows guessing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "curio-key-"));
  try {
    const store = new ContentStore(root);
    await store.initialize();
    assert.equal(await tryAnswer(store, "anything"), "none");
    assert.equal(await readKey(store), null);

    await assert.rejects(writeKey(store, { question: "Junior favourite teacher?" }), /answer/);
    assert.deepEqual(await writeKey(store, { question: "Junior favourite teacher?", answer: "  Ms  Lane " }), { question: "Junior favourite teacher?", answerSet: true });
    const stored = await readKey(store);
    assert.ok(!JSON.stringify(stored).toLowerCase().includes("lane"), "the answer is kept only as a hash");

    assert.equal(await tryAnswer(store, "ms lane"), "open");
    assert.equal(await tryAnswer(store, "MS LANE"), "open");
    assert.equal(await tryAnswer(store, "mr smith"), "wrong");
    assert.equal(await tryAnswer(store, ""), "wrong");

    const token = tokenFor(stored);
    assert.ok(tokenOpens(stored, token));
    assert.ok(!tokenOpens(stored, `${token}x`));
    assert.ok(!tokenOpens(stored, token, Date.now() + 91 * 24 * 60 * 60 * 1000), "it expires");

    // The question alone can change and the answer stays.
    await writeKey(store, { question: "Another question?" });
    assert.ok(tokenOpens(await readKey(store), token));
    // A new answer turns old cookies away.
    await writeKey(store, { question: "Another question?", answer: "something else" });
    assert.ok(!tokenOpens(await readKey(store), token));

    // Too many wrong answers (six in a quarter of an hour, the two above
    // among them): nothing is taken for a while, not even the right one.
    const now = Date.now();
    for (let index = 0; index < 4; index += 1) assert.equal(await tryAnswer(store, `guess ${index}`, now), "wrong");
    assert.equal(await tryAnswer(store, "something else", now), "wait");
    assert.equal(await tryAnswer(store, "something else", now + 16 * 60 * 1000), "open");

    // No question: no key.
    assert.deepEqual(await writeKey(store, { question: "" }), { question: "", answerSet: false });
    assert.equal(await keySummary(store).then((summary) => summary.answerSet), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public and private are the words for visibility in front matter", () => {
  assert.equal(parseEntrySource("---\ntitle: A\nstatus: public\n---\n\nx\n", "a.md").status, "published");
  assert.equal(parseEntrySource("---\ntitle: A\nstatus: private\n---\n\nx\n", "a.md").status, "draft");
  assert.equal(parseEntrySource("---\ntitle: A\nstatus: published\n---\n\nx\n", "a.md").status, "published");
});
