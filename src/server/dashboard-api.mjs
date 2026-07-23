import { keySummary, writeKey } from "./private-key.mjs";

const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_UPLOAD_FILES = 256;

function positiveIntegerSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value > 0) return value;
  console.warn(`[dash] Ignoring invalid ${name}; expected a positive integer.`);
  return fallback;
}

const MAX_JSON_BYTES = positiveIntegerSetting(
  "CURIO_MAX_JSON_BYTES",
  DEFAULT_MAX_JSON_BYTES,
);
const MAX_UPLOAD_BYTES = positiveIntegerSetting(
  "CURIO_MAX_UPLOAD_BYTES",
  DEFAULT_MAX_UPLOAD_BYTES,
);

class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message, options);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function byteLimitLabel(bytes) {
  const mebibytes = bytes / (1024 * 1024);
  return Number.isInteger(mebibytes) ? `${mebibytes} MB` : `${bytes} bytes`;
}

function drainRequest(request) {
  if (request.destroyed || request.readableEnded) return;
  request.once("error", () => {});
  request.resume();
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const body = await readBody(request, MAX_JSON_BYTES, {
    tooLargeMessage: `The request is larger than ${byteLimitLabel(MAX_JSON_BYTES)}.`,
  });
  if (body.length === 0) return {};
  let value;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new HttpError(400, "The JSON body is not valid.", { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "The JSON body must be an object.");
  }
  return value;
}

async function readForm(request) {
  const contentType = String(request.headers["content-type"] || "");
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    drainRequest(request);
    throw new HttpError(400, "The request must use multipart form data.");
  }
  const body = await readBody(request, MAX_UPLOAD_BYTES, {
    tooLargeMessage: `The upload is larger than ${byteLimitLabel(MAX_UPLOAD_BYTES)}.`,
  });
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const webRequest = new Request("http://curio.local/dash/api/import/inspect", {
    method: request.method,
    headers,
    body,
  });
  try {
    return await webRequest.formData();
  } catch (error) {
    throw new HttpError(400, "The multipart form could not be read.", { cause: error });
  }
}

async function filesFromForm(form) {
  const files = form
    .getAll("files")
    .filter((value) => value && typeof value.arrayBuffer === "function");
  if (files.length > MAX_UPLOAD_FILES) {
    throw new HttpError(413, `Upload at most ${MAX_UPLOAD_FILES} files at a time.`);
  }
  try {
    return await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        bytes: Buffer.from(await file.arrayBuffer()),
      })),
    );
  } catch (error) {
    throw new HttpError(400, "One of the uploaded files could not be read.", { cause: error });
  }
}

function readBody(request, maximumBytes, { tooLargeMessage }) {
  const declaredHeader = request.headers["content-length"];
  const declaredSize = declaredHeader === undefined ? null : Number(declaredHeader);
  if (declaredSize !== null && Number.isFinite(declaredSize) && declaredSize > maximumBytes) {
    drainRequest(request);
    throw new HttpError(413, tooLargeMessage);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let drainingOversizedBody = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };

    const onData = (chunk) => {
      if (drainingOversizedBody) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maximumBytes) {
        drainingOversizedBody = true;
        chunks.length = 0;
        if (!settled) {
          settled = true;
          reject(new HttpError(413, tooLargeMessage));
        }
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      cleanup();
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    };

    const onError = (error) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(new HttpError(400, "The request body could not be read.", { cause: error }));
    };

    const onAborted = () => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(new HttpError(400, "The request body was interrupted."));
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

const EXPECTED_STORE_ERRORS = [
  /^Gallery titles can have at most three words\.$/,
  /^Choose an image\.$/,
  /^Gallery uploads must be a PNG, JPEG, GIF, WebP, or AVIF image\.$/,
  /^Gallery item not found\.$/,
  /^An uploaded item is no longer available\.$/,
  /^“.*” has the same title and body as an existing entry\.$/,
  /^The target entry for “.*” was not found\.$/,
  /^The target entry no longer exists\.$/,
  /^The slug “.*” is already in use\.$/,
  /^Entry not found\.$/,
];

function expectedError(error, pathname) {
  if (error instanceof HttpError) return error;
  if ([400, 409, 413, 422].includes(error?.statusCode)) return new HttpError(error.statusCode, error.message);
  if (error instanceof URIError) {
    return new HttpError(400, "The request path is not valid.", { cause: error });
  }
  if (
    error instanceof Error &&
    error.name === "YAMLException" &&
    (pathname === "/dash/api/import/inspect" || pathname === "/dash/api/import/commit")
  ) {
    return new HttpError(400, "The Markdown metadata is not valid YAML.", { cause: error });
  }
  if (
    error instanceof Error &&
    EXPECTED_STORE_ERRORS.some((pattern) => pattern.test(error.message))
  ) {
    return new HttpError(400, error.message, { cause: error });
  }
  if (
    error &&
    typeof error === "object" &&
    error.code === "ENOENT" &&
    pathname === "/dash/api/import/commit"
  ) {
    return new HttpError(400, "The import review is no longer available.", { cause: error });
  }
  return null;
}

function entryId(pathname) {
  const match = pathname.match(/^\/dash\/api\/entries\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function historyEventId(pathname) {
  const match = pathname.match(/^\/dash\/api\/history\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function stagedBatchId(pathname) {
  const match = pathname.match(/^\/dash\/api\/import\/staged\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * @param {import('./content-store.mjs').ContentStore} store
 * @param {{resolveUploads?: ((ids: string[]) => Promise<{name: string, bytes: Buffer}[]>) | null, signUploads?: ((files: {name: string, size: number}[]) => Promise<unknown>) | null, seed?: (() => Promise<Array<{filename: string, source: string}> | null | undefined>) | null}} [options]
 */
export function createDashboardApi(store, { resolveUploads = null, signUploads = null, seed = null } = {}) {
  return async function dashboardApi(request, response) {
    const url = new URL(request.url || "/", "http://curio.local");
    const pathname = url.pathname;

    try {
      if (request.method === "GET" && pathname === "/dash/api/capabilities") {
        json(response, 200, { data: { directUploads: Boolean(resolveUploads) } });
        return true;
      }
      if (request.method === "POST" && pathname === "/dash/api/uploads" && signUploads) {
        json(response, 200, { data: await signUploads((await readJson(request)).files) });
        return true;
      }
      if (request.method === "GET" && pathname === "/dash/api/status") {
        await store.initialize();
        json(response, 200, { ok: true });
        return true;
      }

      if (request.method === "GET" && pathname === "/dash/api/entries") {
        await store.moveGalleryIntoEntries();
        // Optional: entries to add once, the first time the list is opened
        // (seed returns them, or nothing; see ContentStore.seedExamples).
        if (seed) {
          const examples = await seed();
          if (examples?.length) await store.seedExamples(examples);
        }
        const records = await store.listRecords();
        json(response, 200, { data: records });
        return true;
      }

      const lineageId = entryId(pathname);
      if (request.method === "GET" && lineageId) {
        const record = await store.getRecord(lineageId, { includeBody: true });
        if (!record) json(response, 404, { error: "Entry not found." });
        else json(response, 200, { data: record });
        return true;
      }

      if (request.method === "POST" && pathname === "/dash/api/entries") {
        json(response, 200, { data: await store.createEntry(await readJson(request)) });
        return true;
      }

      if (request.method === "DELETE" && lineageId) {
        json(response, 200, { data: await store.deleteEntry(lineageId) });
        return true;
      }

      if (request.method === "PATCH" && lineageId) {
        const record = await store.updateEntry(lineageId, await readJson(request));
        json(response, 200, { data: record });
        return true;
      }

      if (request.method === "POST" && pathname === "/dash/api/import/inspect") {
        const files = resolveUploads && /^application\/json/i.test(request.headers["content-type"] || "")
          ? await resolveUploads((await readJson(request)).uploads)
          : await filesFromForm(await readForm(request));
        if (files.length === 0) {
          json(response, 400, { error: "Choose at least one Markdown file." });
          return true;
        }
        const result = await store.inspectUpload(files);
        json(response, 200, { data: result });
        return true;
      }

      if (request.method === "GET" && pathname === "/dash/api/import/staged") {
        json(response, 200, { data: await store.listStagedBatches() });
        return true;
      }

      const stagedId = stagedBatchId(pathname);
      if (request.method === "GET" && stagedId) {
        const batch = await store.getStagedBatch(stagedId);
        if (!batch) json(response, 404, { error: "Unfinished import not found." });
        else json(response, 200, { data: batch });
        return true;
      }

      if (request.method === "DELETE" && stagedId) {
        const discarded = await store.discardStagedBatch(stagedId);
        if (!discarded) json(response, 404, { error: "Unfinished import not found." });
        else json(response, 200, { data: { discarded: true } });
        return true;
      }

      if (request.method === "POST" && pathname === "/dash/api/import/commit") {
        const payload = await readJson(request);
        if (!payload.batchId || !Array.isArray(payload.items)) {
          json(response, 400, { error: "The import review is incomplete." });
          return true;
        }
        const result = await store.commitBatch(payload.batchId, payload.items);
        json(response, 200, { data: result });
        return true;
      }

      if (request.method === "GET" && pathname === "/dash/api/history") {
        const events = await store.history(url.searchParams.get("limit") || 200);
        json(response, 200, { data: events });
        return true;
      }

      const eventId = historyEventId(pathname);
      if (request.method === "GET" && eventId) {
        const event = await store.historyDetail(eventId);
        if (!event) json(response, 404, { error: "History event not found." });
        else json(response, 200, { data: event });
        return true;
      }

      if (request.method === "GET" && pathname === "/dash/api/site") {
        json(response, 200, { data: await store.getSiteSettings() });
        return true;
      }

      if (request.method === "PATCH" && pathname === "/dash/api/site") {
        json(response, 200, { data: await store.updateSiteSettings(await readJson(request)) });
        return true;
      }

      if (request.method === "GET" && pathname === "/dash/api/key") {
        json(response, 200, { data: await keySummary(store) });
        return true;
      }

      if (request.method === "PUT" && pathname === "/dash/api/key") {
        json(response, 200, { data: await writeKey(store, await readJson(request)) });
        return true;
      }

      if (request.method === "POST" && pathname === "/dash/api/categories") {
        json(response, 200, { data: await store.reorganizeCategories(await readJson(request)) });
        return true;
      }

      const assetMatch = pathname.match(/^\/dash\/api\/entries\/([^/]+)\/assets$/);
      if (request.method === "POST" && assetMatch) {
        let files;
        if (resolveUploads && /^application\/json/i.test(request.headers["content-type"] || "")) {
          files = await resolveUploads((await readJson(request)).uploads);
        } else {
          files = await filesFromForm(await readForm(request));
        }
        json(response, 200, { data: await store.addEntryAsset(decodeURIComponent(assetMatch[1]), files[0]) });
        return true;
      }

      if (request.method === "GET" && pathname === "/dash/api/gallery") {
        json(response, 200, { data: await store.listGallery() });
        return true;
      }

      if (request.method === "POST" && pathname === "/dash/api/gallery") {
        let files, metadata;
        if (resolveUploads && /^application\/json/i.test(request.headers["content-type"] || "")) {
          const payload = await readJson(request);
          files = await resolveUploads(payload.uploads);
          metadata = payload.metadata || {};
        } else {
          const form = await readForm(request);
          files = await filesFromForm(form);
          metadata = Object.fromEntries(["title", "description", "displayDate", "status"].map(key => [key, form.get(key)]));
        }
        const item = await store.addGalleryItem(files[0], metadata);
        json(response, 200, { data: item });
        return true;
      }

      const galleryMatch = pathname.match(/^\/dash\/api\/gallery\/([^/]+)$/);
      if (request.method === "PATCH" && galleryMatch) {
        const item = await store.updateGalleryItem(
          decodeURIComponent(galleryMatch[1]),
          await readJson(request),
        );
        json(response, 200, { data: item });
        return true;
      }

      return false;
    } catch (error) {
      const clientError = expectedError(error, pathname);
      if (!clientError) {
        console.error(`[dash] ${request.method} ${pathname}:`, error);
      }
      if (!response.headersSent && !response.writableEnded) {
        json(response, clientError?.statusCode || 500, {
          error: clientError?.message || "The request could not be completed.",
        });
      } else if (!response.writableEnded) {
        response.end();
      }
      return true;
    }
  };
}
