import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFilesEntries, readFilesSite } from "../src/server/files-source.mjs";

test("a folder in Git is read as entries: public ones only, one per address, settings from site.json", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "curio-files-"));
  try {
    await mkdir(path.join(root, "notes", "images"), { recursive: true });
    await mkdir(path.join(root, "_drafts"), { recursive: true });
    await writeFile(path.join(root, "notes", "a-shore.md"), "---\ntitle: A shore\ndate: 2026-01-02\nfolder: notes / fieldwork\ntags: [water]\nstatus: public\n---\n\n![Still water](images/lake.jpg \"Still\")\n");
    await writeFile(path.join(root, "page.html"), "---\ntitle: A page\nstatus: public\n---\n\n<section><p>HTML</p></section>\n");
    await writeFile(path.join(root, "hidden.md"), "---\ntitle: Hidden\nstatus: private\n---\n\nNot read.\n");
    await writeFile(path.join(root, "_drafts", "skipped.md"), "---\ntitle: Skipped\nstatus: public\n---\n\nx\n");
    await writeFile(path.join(root, "README.md"), "# Not an entry\n");
    await writeFile(path.join(root, "site.json"), JSON.stringify({ contactLine: "Write to {email}.", tabs: ["notes"] }));

    const entries = await readFilesEntries(root);
    assert.deepEqual(entries.map((entry) => entry.title).sort(), ["A page", "A shore"]);
    const shore = entries.find((entry) => entry.slug === "a-shore");
    assert.equal(shore.type, "notes / fieldwork");
    assert.deepEqual(shore.tags, ["water"]);
    assert.equal(shore.sourceFilename, "notes/a-shore.md");
    assert.equal(shore.mediaRoot, "files");
    assert.match(shore.body, /images\/lake\.jpg/);

    const site = await readFilesSite(root);
    assert.equal(site.contactLine, "Write to {email}.");
    assert.equal(site.tabs, "notes");
    assert.equal(site.categories, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
