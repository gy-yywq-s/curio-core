import test from "node:test";
import assert from "node:assert/strict";
import { prepareUploads, consumeUploads } from "../src/server/direct-uploads.mjs";

test("direct uploads bind server-issued tickets to a private object, enforce size and consume once", async () => {
  const originalFetch = globalThis.fetch;
  const previous = { ...process.env };
  const docs = new Map();
  const files = {
    async writeFile(key, value) { docs.set(key, value); },
    async readFile(key) { if (!docs.has(key)) throw Object.assign(new Error("Missing"), { code: "ENOENT" }); return docs.get(key); },
    async rm(key) { docs.delete(key); },
  };
  try {
    process.env.CURIO_STORAGE_NAMESPACE = "test";
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-only-key";
    let downloads = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers.apikey, "test-server-only-key");
      if (options.method === "POST") return Response.json({ url: `/object/upload/sign/curio-test/file?token=short-lived` });
      downloads++;
      return new Response(Buffer.from("abc"));
    };
    const [signed] = await prepareUploads(files, [{ name: "folder/image.png", size: 3 }]);
    assert.equal(new URL(signed.url).origin, "https://example.supabase.co");
    const [upload] = await consumeUploads(files, [signed.id]);
    assert.equal(upload.bytes.toString(), "abc");
    assert.equal(upload.name, "folder/image.png");
    assert.ok(files.preuploaded.get(upload.bytes));
    await assert.rejects(consumeUploads(files, [signed.id]), /expired/);
    assert.equal(downloads, 1);
    await assert.rejects(prepareUploads(files, [{ name: "../secret", size: 3 }]), /filename/);
    await assert.rejects(prepareUploads(files, [{ name: "huge.png", size: 65 * 1024 * 1024 }]), /64 MB/);
    const [small] = await prepareUploads(files, [{ name: "small.png", size: 2 }]);
    await assert.rejects(consumeUploads(files, [small.id]), /declared size/);
    assert.ok(docs.size, "failed validation leaves the ticket recoverable");
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of ["CURIO_STORAGE_NAMESPACE", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
