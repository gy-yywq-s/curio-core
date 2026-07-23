import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ContentStore, contentHash, parseEntrySource } from "../src/server/content-store.mjs";

test("content identity includes title and body, but excludes other metadata", () => {
  const first = parseEntrySource(
    `---\ntitle: Same\ndate: 2026-01-01\ntype: note\n---\n\nBody\n`,
    "one.md",
  );
  const second = parseEntrySource(
    `---\ntitle: Same\ndate: 2031-09-09\ntype: draft\nlanguage: fr\n---\n\nBody\n`,
    "two.md",
  );
  assert.equal(first.contentHash, second.contentHash);
  assert.notEqual(first.contentHash, contentHash("Different", "Body"));
  assert.notEqual(first.contentHash, contentHash("Same", "Different body"));
});

test("gallery titles stay short and site details remain editable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curio-gallery-"));
  const store = new ContentStore(directory);

  try {
    const image = { name: "pixel.png", bytes: Buffer.from("image") };
    await assert.rejects(
      store.addGalleryItem(image, { title: "one two three four" }),
      /at most three words/i,
    );
    const item = await store.addGalleryItem(image, {
      title: "three small words",
      description: "Only visible after opening the image.",
      status: "published",
    });
    assert.equal(item.title, "three small words");
    assert.equal(item.description, "Only visible after opening the image.");

    const defaults = await store.getSiteSettings();
    // A new site starts with nothing of anyone's in it.
    assert.deepEqual(defaults, { about: "", contactEmail: "", contactLine: "", categories: "", tabs: "" });

    const settings = await store.updateSiteSettings({
      about: "Editable.",
      contactEmail: "elsewhere@example.com",
      contactLine: "Write to {email} about this.",
    });
    assert.equal(settings.about, "Editable.");
    assert.equal(settings.contactEmail, "elsewhere@example.com");
    assert.equal(settings.contactLine, "Write to {email} about this.");

    const [siteEvent, galleryEvent] = await store.history();
    assert.deepEqual(
      siteEvent.changes.find((change) => change.field === "about"),
      { field: "about", before: "", after: "Editable." },
    );
    assert.deepEqual(
      galleryEvent.changes.find((change) => change.field === "title"),
      { field: "title", before: null, after: "three small words" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports preserve a stable lineage, immutable revision times, and editable public times", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curio-store-"));
  const store = new ContentStore(directory);

  try {
    const initial = Buffer.from(
      `---\ntitle: First title\ndate: 2026-07-01\nstatus: published\n---\n\nFirst body.\n`,
    );
    const batch = await store.inspectUpload([{ name: "entry.md", bytes: initial }]);
    assert.equal(batch.items[0].match, "new");
    const [created] = await store.commitBatch(batch.batchId, [
      {
        itemId: batch.items[0].itemId,
        action: "new",
        overrides: {
          title: batch.items[0].title,
          slug: batch.items[0].slug,
          displayDate: batch.items[0].displayDate,
          displayEditedAt: null,
          showEdited: false,
          type: null,
          language: "en",
          status: "published",
        },
      },
    ]);
    assert.equal(created.revisionCount, 1);
    assert.equal(created.contentEditedAt, null);
    await assert.rejects(
      readFile(path.join(directory, "staging", batch.batchId, "manifest.json"), "utf8"),
      { code: "ENOENT" },
    );

    const recordFilename = path.join(directory, "records", `${created.lineageId}.json`);
    const legacyRecord = JSON.parse(await readFile(recordFilename, "utf8"));
    legacyRecord.currentRevision = legacyRecord.currentRevision.replaceAll("/", "\\");
    legacyRecord.revisions = legacyRecord.revisions.map((revision) => ({
      ...revision,
      revisionPath: revision.revisionPath.replaceAll("/", "\\"),
    }));
    await writeFile(recordFilename, `${JSON.stringify(legacyRecord, null, 2)}\n`, "utf8");
    const legacyReadable = await store.getRecord(created.lineageId, { includeBody: true });
    assert.match(legacyReadable.body, /First body/);

    const repeatBatch = await store.inspectUpload([{ name: "renamed.md", bytes: initial }]);
    assert.equal(repeatBatch.items[0].match, "exact");
    assert.equal(repeatBatch.items[0].slug, created.slug);
    assert.equal(repeatBatch.items[0].displayDate, created.displayDate);
    await assert.rejects(
      store.commitBatch(repeatBatch.batchId, [
        {
          itemId: repeatBatch.items[0].itemId,
          action: "new",
          overrides: repeatBatch.items[0],
        },
      ]),
      /same title and body/i,
    );
    assert.match(
      await readFile(
        path.join(directory, "staging", repeatBatch.batchId, "manifest.json"),
        "utf8",
      ),
      new RegExp(repeatBatch.batchId),
    );
    const [repeated] = await store.commitBatch(repeatBatch.batchId, [
      {
        itemId: repeatBatch.items[0].itemId,
        action: "reupload",
        targetLineageId: created.lineageId,
        overrides: repeatBatch.items[0],
      },
    ]);
    assert.equal(repeated.lineageId, created.lineageId);
    assert.equal(repeated.revisionCount, 1);
    assert.equal(repeated.contentHash, created.contentHash);
    assert.equal(repeated.currentRevision.includes("\\"), false);

    const revision = Buffer.from(
      `---\ntitle: First title\nstatus: published\n---\n\nA changed body.\n`,
    );
    const revisionBatch = await store.inspectUpload([{ name: "entry.md", bytes: revision }]);
    assert.equal(revisionBatch.items[0].match, "slug");
    assert.equal(revisionBatch.items[0].displayDate, created.displayDate);
    assert.equal(revisionBatch.items[0].showEdited, true);
    const [revised] = await store.commitBatch(revisionBatch.batchId, [
      {
        itemId: revisionBatch.items[0].itemId,
        action: "revise",
        targetLineageId: created.lineageId,
        overrides: revisionBatch.items[0],
      },
    ]);
    assert.equal(revised.lineageId, created.lineageId);
    assert.equal(revised.revisionCount, 2);
    assert.ok(revised.contentEditedAt);
    assert.ok(revised.displayEditedAt);

    const internalEditTime = revised.contentEditedAt;
    const displayOnly = await store.updateEntry(created.lineageId, {
      displayDate: "2019-02-03T00:00:00Z",
      displayEditedAt: "2020-04-05T00:00:00Z",
      showEdited: false,
    });
    assert.equal(displayOnly.contentHash, revised.contentHash);
    assert.equal(displayOnly.revisionCount, 2);
    assert.equal(displayOnly.contentEditedAt, internalEditTime);
    assert.equal(displayOnly.displayDate, "2019-02-03T00:00:00.000Z");
    assert.equal(displayOnly.displayEditedAt, "2020-04-05T00:00:00.000Z");
    assert.equal(displayOnly.showEdited, false);

    const events = (await readFile(path.join(directory, "logs", "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.type),
      ["created", "reuploaded", "content_revised", "metadata_updated"],
    );
    const revisionDetail = await store.historyDetail(events[2].eventId);
    assert.ok(revisionDetail);
    assert.ok(
      revisionDetail.diff.some(
        (line) => line.kind === "remove" && line.text === "First body.",
      ),
    );
    assert.ok(
      revisionDetail.diff.some(
        (line) => line.kind === "add" && line.text === "A changed body.",
      ),
    );
    assert.deepEqual(
      events[3].changes.find((change) => change.field === "showEdited"),
      { field: "showEdited", before: true, after: false },
    );
    assert.equal(events[3].showEdited, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("history detail returns null for an unknown event", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curio-history-"));
  try {
    assert.equal(await new ContentStore(directory).historyDetail("missing"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unfinished imports can be listed, refreshed against current entries, resumed, and discarded", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curio-resume-"));
  const store = new ContentStore(directory);
  const source = Buffer.from("---\ntitle: Recover me\n---\n\nSaved upload.\n");

  try {
    const batch = await store.inspectUpload([{ name: "recover.md", bytes: source }]);
    const [summary] = await store.listStagedBatches();
    assert.equal(summary.batchId, batch.batchId);
    assert.equal(summary.itemCount, 1);
    assert.deepEqual(summary.titles, ["Recover me"]);

    const entry = parseEntrySource(source, "recover.md");
    const created = await store.applyEntry(entry);
    const resumed = await store.getStagedBatch(batch.batchId);
    assert.equal(resumed.items[0].match, "exact");
    assert.equal(resumed.items[0].action, "reupload");
    assert.equal(resumed.items[0].targetLineageId, created.lineageId);

    assert.equal(await store.discardStagedBatch(batch.batchId), true);
    assert.deepEqual(await store.listStagedBatches(), []);
    assert.equal(await store.getStagedBatch(batch.batchId), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("abandoned upload batches expire and explicit missing revision targets are rejected", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curio-staging-"));
  const store = new ContentStore(directory);

  try {
    const batch = await store.inspectUpload([
      { name: "draft.md", bytes: Buffer.from("# Draft\n\nBody.\n") },
    ]);
    const batchDirectory = path.join(directory, "staging", batch.batchId);
    const manifestFilename = path.join(batchDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFilename, "utf8"));
    const expiredAt = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    manifest.createdAt = expiredAt.toISOString();
    await writeFile(manifestFilename, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await utimes(batchDirectory, expiredAt, expiredAt);

    await new ContentStore(directory).initialize();
    await assert.rejects(readFile(manifestFilename, "utf8"), { code: "ENOENT" });

    const entry = parseEntrySource("# Missing target\n\nBody.\n", "missing.md");
    await assert.rejects(
      store.applyEntry(entry, { targetLineageId: "11111111-1111-4111-8111-111111111111" }),
      /no longer exists|not found/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTML that sets its own colours or fonts saves as a draft but cannot be published", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curio-html-rules-"));
  try {
    const store = new ContentStore(directory);
    const source = (status) =>
      `---\ntitle: Loud page\nstatus: ${status}\n---\n\n<style>.loud { color: red; font-family: Arial; }</style>\n<section class="loud"><p>Hi</p></section>\n<script type="module">document.body.style.background = "pink";</script>`;
    const draft = await store.applyEntry(parseEntrySource(source("draft"), "loud.html"));
    assert.equal(draft.status, "draft");
    await assert.rejects(
      store.applyEntry(parseEntrySource(source("published"), "loud.html"), { targetLineageId: draft.lineageId }),
      (error) => error.statusCode === 422 && error.problems.length >= 3,
    );
    const quiet = await store.applyEntry(
      parseEntrySource("---\ntitle: Quiet page\nstatus: published\n---\n\n<style>.quiet { color: var(--muted); }</style>\n<section class=\"quiet\"><p>Hi</p></section>", "quiet.html"),
    );
    assert.equal(quiet.status, "published");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("videos sit beside an entry, and a short title can be kept off its picture", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "curio-video-"));
  try {
    const store = new ContentStore(directory);
    const entry = await store.applyEntry(
      parseEntrySource(
        "---\ntitle: A clip\nstatus: published\ncover: { src: images/a.jpg, description: Water, short: Still water }\nquietPictures: [images/a.jpg]\n---\n\nWords.\n",
        "clip.md",
      ),
    );
    assert.deepEqual(entry.quietPictures, ["images/a.jpg"]);
    const video = await store.addEntryAsset(entry.lineageId, { name: "lake drift.webm", bytes: Buffer.from("webm") });
    assert.match(video.path, /^videos\/[0-9a-f]{8}-lake-drift\.webm$/);
    const picture = await store.addEntryAsset(entry.lineageId, { name: "x.png", bytes: Buffer.from("png") });
    assert.match(picture.path, /^images\//);
    await assert.rejects(
      store.addEntryAsset(entry.lineageId, { name: "notes.txt", bytes: Buffer.from("text") }),
      (error) => error.statusCode === 400 && /notes\.txt/.test(error.message),
    );
    const updated = await store.updateEntry(entry.lineageId, { quietPictures: [], expectedLastObservedAt: entry.lastObservedAt });
    assert.deepEqual(updated.quietPictures, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
