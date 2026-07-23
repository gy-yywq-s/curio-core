import * as nodeFs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { diffLines } from "./history-diff.mjs";
import { htmlProblems, isHtmlBody } from "./html-rules.mjs";

const RECORD_VERSION = 1;
const STAGING_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_SITE_SETTINGS = {
  about: "",
  contactEmail: "",
  contactLine: "",
  categories: "",
  tabs: "",
};
const recognizedMetadata = new Set([
  "title",
  "slug",
  "date",
  "published",
  "displayDate",
  "edited",
  "editedAt",
  "displayEditedAt",
  "showEdited",
  "show_edited",
  "type",
  "folder",
  "flower",
  "tags",
  "cover",
  "quietPictures",
  "excerpt",
  "summary",
  "status",
  "curio_id",
  "lineageId",
  "content_hash",
]);

function textValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function galleryTitle(value) {
  const title = textValue(value);
  if (title.split(/\s+/).filter(Boolean).length > 3) {
    throw new Error("Gallery titles can have at most three words.");
  }
  return title;
}

function normalizedGalleryItem(item) {
  const legacyCaption = textValue(item?.caption);
  return {
    ...item,
    title:
      textValue(item?.title) || legacyCaption.split(/\s+/).filter(Boolean).slice(0, 3).join(" "),
    description: textValue(item?.description) || legacyCaption,
  };
}

/** How far open an entry's flower rests: a whole percentage from 0 to 80, or null. */
function flowerValue(value) {
  const number = typeof value === "string" && value.trim() ? Number(value.replace("%", "")) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  return Math.min(80, Math.max(0, Math.round(number)));
}

/** Tags: flat names, from a list or a comma-separated line, each once. */
export function tagList(value) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set();
  const tags = [];
  for (const item of items) {
    const tag = String(item ?? "").trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}

/**
 * A cover, from front matter (`cover: images/x.jpg`, or
 * `cover: { src: …, description: …, short: … }`) or from the dashboard
 * (`cover`, `coverDescription`, `coverShort`).
 */
function coverFields(overrides, value) {
  const given = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const object = value && typeof value === "object" ? value : {};
  const src = given("cover") ? overrides.cover : typeof value === "string" ? value : object.src;
  return {
    cover: textValue(src) || null,
    coverDescription: textValue(given("coverDescription") ? overrides.coverDescription : object.description) || null,
    coverShort: textValue(given("coverShort") ? overrides.coverShort : object.short) || null,
  };
}

function booleanValue(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function normalizeBody(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function parseFrontMatter(source) {
  const normalized = String(source || "").replace(/^\uFEFF/, "");
  const match = normalized.match(
    /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/,
  );

  if (!match) return { data: {}, content: normalized };

  const parsed = parseYaml(match[1]);
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  return { data, content: normalized.slice(match[0].length) };
}

export function titleFromMarkdown(markdown) {
  const match = String(markdown || "").match(/^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/);
  return {
    title: match?.[1]?.replace(/[*_`]/g, "").trim() || "",
    body: match ? markdown.slice(match[0].length).trimStart() : markdown,
  };
}

function dateFromFilename(filename) {
  return filename.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})(?:-|$)/)?.[1] || "";
}

function normalizedDate(value, fallback) {
  const supplied = value instanceof Date ? value : textValue(value);
  const candidate = supplied ? new Date(supplied) : new Date(fallback);
  return Number.isNaN(candidate.valueOf()) ? new Date(fallback).toISOString() : candidate.toISOString();
}

function optionalDate(value) {
  if (value === null || value === false || value === "") return null;
  const supplied = value instanceof Date ? value : textValue(value);
  if (!supplied) return null;
  const candidate = new Date(supplied);
  return Number.isNaN(candidate.valueOf()) ? null : candidate.toISOString();
}

export function contentHash(title, body) {
  const canonical = `${String(title || "").trim()}\n\0\n${normalizeBody(body)}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function cleanRelativePath(value) {
  const pieces = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((piece) => piece && piece !== "." && piece !== "..");
  return pieces.join("/").replace(/\0/g, "") || "upload";
}

function fallbackTitle(filename) {
  return path.posix
    .basename(filename, path.posix.extname(filename))
    .replace(/^\d{4}-\d{2}-\d{2}-?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

function extraMetadata(data) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !recognizedMetadata.has(key)));
}

function metadataValue(overrides, key, fallback) {
  return Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : fallback;
}

/**
 * An .html file as an entry: its title is the <title> (or the first <h1>,
 * which is then taken out, since the site sets the title itself), its body
 * what is inside <body>. Scripts are dropped; the site does not run them.
 */
export function entryFromHtml(html) {
  const text = String(html || "");
  const titleTag = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const heading = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const plain = (value) => value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const styles = (text.match(/<head[\s\S]*?<\/head>/i)?.[0].match(/<style[\s\S]*?<\/style>/gi) || []).join("\n");
  let body = text.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? text.replace(/<!doctype[^>]*>|<head[\s\S]*?<\/head>|<\/?html[^>]*>/gi, "");
  if (heading) body = body.replace(heading[0], "");
  body = `${styles}\n${body}`.trim();
  // The site reads a body as HTML when it begins with a block tag.
  if (!isHtmlBody(body)) {
    body = `<section>\n${body}\n</section>`;
  }
  return { title: plain(titleTag?.[1] || "") || plain(heading?.[1] || ""), body };
}

export function parseEntrySource(source, filename, options = {}) {
  const now = options.now || new Date().toISOString();
  const overrides = options.overrides || {};
  const parsed = parseFrontMatter(source);
  const markdown = /\.html?$/i.test(filename) ? entryFromHtml(parsed.content) : titleFromMarkdown(parsed.content);
  const sourcePath = cleanRelativePath(filename);
  const title =
    textValue(metadataValue(overrides, "title", parsed.data.title)) ||
    markdown.title ||
    fallbackTitle(sourcePath) ||
    "[untitled]";
  const body = normalizeBody(metadataValue(overrides, "body", markdown.body));
  const proposedSlug =
    textValue(metadataValue(overrides, "slug", parsed.data.slug)) ||
    slugify(path.posix.basename(sourcePath, path.posix.extname(sourcePath))) ||
    slugify(title) ||
    "entry";
  const displayDateValue = metadataValue(
    overrides,
    "displayDate",
    parsed.data.date ?? parsed.data.published ?? parsed.data.displayDate ?? dateFromFilename(sourcePath),
  );
  const displayEditedValue = metadataValue(
    overrides,
    "displayEditedAt",
    parsed.data.edited ?? parsed.data.editedAt ?? parsed.data.displayEditedAt,
  );
  const displayEditedAt = optionalDate(displayEditedValue);
  const hasDisplayDate =
    Object.prototype.hasOwnProperty.call(overrides, "displayDate") ||
    parsed.data.date !== undefined ||
    parsed.data.published !== undefined ||
    parsed.data.displayDate !== undefined ||
    Boolean(dateFromFilename(sourcePath));
  const hasDisplayEditedAt =
    Object.prototype.hasOwnProperty.call(overrides, "displayEditedAt") ||
    parsed.data.edited !== undefined ||
    parsed.data.editedAt !== undefined ||
    parsed.data.displayEditedAt !== undefined;
  const hasShowEdited =
    Object.prototype.hasOwnProperty.call(overrides, "showEdited") ||
    parsed.data.showEdited !== undefined ||
    parsed.data.show_edited !== undefined;
  const showEdited = booleanValue(
    metadataValue(
      overrides,
      "showEdited",
      parsed.data.showEdited ?? parsed.data.show_edited,
    ),
    Boolean(displayEditedAt),
  );
  const statusValue = textValue(metadataValue(overrides, "status", parsed.data.status));

  return {
    title,
    slug: slugify(proposedSlug) || "entry",
    hasSlug:
      Object.prototype.hasOwnProperty.call(overrides, "slug") || parsed.data.slug !== undefined,
    displayDate: normalizedDate(displayDateValue, now),
    displayEditedAt,
    showEdited,
    hasDisplayDate,
    hasDisplayEditedAt,
    hasShowEdited,
    type: textValue(metadataValue(overrides, "type", parsed.data.folder ?? parsed.data.type)) || null,
    hasType:
      Object.prototype.hasOwnProperty.call(overrides, "type") ||
      parsed.data.type !== undefined ||
      parsed.data.folder !== undefined,
    flower: flowerValue(metadataValue(overrides, "flower", parsed.data.flower)),
    hasFlower:
      Object.prototype.hasOwnProperty.call(overrides, "flower") || parsed.data.flower !== undefined,
    tags: tagList(metadataValue(overrides, "tags", parsed.data.tags)),
    // Pictures (by file) whose short title is not put on the picture.
    quietPictures: tagList(metadataValue(overrides, "quietPictures", parsed.data.quietPictures)),
    ...coverFields(overrides, parsed.data.cover),
    hasCover: Object.prototype.hasOwnProperty.call(overrides, "cover") || parsed.data.cover !== undefined,
    excerpt: textValue(metadataValue(overrides, "excerpt", parsed.data.excerpt ?? parsed.data.summary)) || null,
    hasExcerpt:
      Object.prototype.hasOwnProperty.call(overrides, "excerpt") ||
      parsed.data.excerpt !== undefined ||
      parsed.data.summary !== undefined,
    hasTags:
      Object.prototype.hasOwnProperty.call(overrides, "tags") || parsed.data.tags !== undefined,
    // "public" and "private" are the words; "published" and "draft" are how they are kept.
    status: ["published", "public"].includes(statusValue.toLowerCase()) ? "published" : "draft",
    hasStatus:
      Object.prototype.hasOwnProperty.call(overrides, "status") || parsed.data.status !== undefined,
    extras: { ...extraMetadata(parsed.data), ...(overrides.extras || {}) },
    body,
    sourceFilename: sourcePath,
    requestedLineageId:
      textValue(parsed.data.curio_id) || textValue(parsed.data.lineageId) || null,
    contentHash: contentHash(title, body),
  };
}

function canonicalSource(entry, lineageId) {
  const data = {
    ...entry.extras,
    title: entry.title,
    slug: entry.slug,
    date: entry.displayDate,
    ...(entry.displayEditedAt ? { edited: entry.displayEditedAt } : {}),
    ...(!entry.showEdited ? { show_edited: false } : {}),
    ...(entry.type ? { type: entry.type } : {}),
    ...(typeof entry.flower === "number" ? { flower: entry.flower } : {}),
    ...(entry.tags?.length ? { tags: entry.tags } : {}),
    ...(entry.cover
      ? {
          cover:
            entry.coverDescription || entry.coverShort
              ? {
                  src: entry.cover,
                  ...(entry.coverDescription ? { description: entry.coverDescription } : {}),
                  ...(entry.coverShort ? { short: entry.coverShort } : {}),
                }
              : entry.cover,
        }
      : {}),
    ...(entry.quietPictures?.length ? { quietPictures: entry.quietPictures } : {}),
    ...(entry.excerpt ? { excerpt: entry.excerpt } : {}),
    status: entry.status,
    curio_id: lineageId,
    content_hash: entry.contentHash,
  };
  return `---\n${dumpYaml(data, { noRefs: true, lineWidth: -1, sortKeys: false }).trim()}\n---\n\n${entry.body}\n`;
}

const historyFields = [
  "title",
  "slug",
  "displayDate",
  "displayEditedAt",
  "showEdited",
  "type",
  "flower",
  "tags",
  "cover",
  "coverDescription",
  "coverShort",
  "quietPictures",
  "excerpt",
  "status",
];

function historyChanges(before, after) {
  return changesForFields(before, after, historyFields);
}

function changesForFields(before, after, fields) {
  return fields.flatMap((field) => {
    const beforeValue = before?.[field] ?? null;
    const afterValue = after?.[field] ?? null;
    const same = Array.isArray(beforeValue) || Array.isArray(afterValue)
      ? JSON.stringify(beforeValue || []) === JSON.stringify(afterValue || [])
      : beforeValue === afterValue;
    return same
      ? []
      : [{ field, before: beforeValue, after: afterValue }];
  });
}

function normalizedStoredPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:\//.test(normalized)
  ) {
    throw new Error("Stored path must be relative to the content store.");
  }

  const pieces = normalized.split("/").filter((piece) => piece && piece !== ".");
  if (!pieces.length || pieces.some((piece) => piece === "..")) {
    throw new Error("Stored path escapes the content store.");
  }
  return pieces.join("/");
}

function resolveStoredPath(root, value) {
  const relativePath = normalizedStoredPath(value);
  const filename = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, filename);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Stored path escapes the content store.");
  }
  return filename;
}

function referencedAssets(body, sourceFilename, extra = []) {
  const references = new Set();
  for (const match of String(body).matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) extra = [...extra, match[1]];
  for (const raw of extra) {
    if (!raw || /^(?:[a-z]+:|\/|#)/i.test(raw)) continue;
    references.add(cleanRelativePath(path.posix.join(path.posix.dirname(sourceFilename), raw)));
  }
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of body.matchAll(pattern)) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (/^(?:[a-z]+:|\/|#)/i.test(raw)) continue;
    const decoded = decodeURIComponent(raw.split(/[?#]/)[0]);
    const resolved = cleanRelativePath(
      path.posix.join(path.posix.dirname(sourceFilename), decoded),
    );
    references.add(resolved);
  }
  return [...references];
}

/* Categories (see src/model.ts): a path is names joined by " / "; an
   entry's type is its paths joined by "; "; the site keeps the tree's
   order as one path per line. */
const categoryPath = (text) => String(text).split("/").map((name) => name.trim()).filter(Boolean);
const categoryKey = (path) => path.map((name) => name.toLowerCase()).join("/");

/** Paths, one per line, each once. With `withParents`, every folder's parents are listed before it. */
function categoryLines(lines, withParents = true) {
  const seen = new Set();
  const kept = [];
  const keep = (path) => {
    const key = categoryKey(path);
    if (path.length === 0 || seen.has(key)) return;
    seen.add(key);
    kept.push(path.join(" / "));
  };
  for (const line of lines) {
    const path = categoryPath(line);
    if (withParents) path.forEach((_, depth) => keep(path.slice(0, depth + 1)));
    else keep(path);
  }
  return kept.join("\n");
}

/**
 * An entry's path after the folder `from` is moved to `to`. With `to`
 * null the folder is removed, and what was in it (or under it) goes to
 * the folder that held it.
 */
export function movedType(type, from, to) {
  const path = categoryPath(type || "");
  const fromPath = categoryPath(from);
  const fromKey = categoryKey(fromPath);
  const key = categoryKey(path);
  if (!(key === fromKey || key.startsWith(`${fromKey}/`))) return type || null;
  const next = to === null ? fromPath.slice(0, -1) : [...categoryPath(to), ...path.slice(fromPath.length)];
  return next.join(" / ") || null;
}

const videoFile = /\.(?:mp4|m4v|webm|mov)$/i;
const pictureFile = /\.(?:png|jpe?g|gif|webp|avif|svg|mp4|m4v|webm|mov)$/i;
/**
 * A picture or video uploaded on its own becomes an entry beside it, named
 * after it: a picture as the entry's cover, a video as its body.
 */
const pictureEntryName = (filename) => filename.replace(/\.[^./]+$/, "") + ".md";
const pictureSource = (filename) => videoFile.test(filename)
  ? `![](${encodeURI(path.posix.basename(filename))})\n`
  : `---\ncover: ${JSON.stringify(path.posix.basename(filename))}\n---\n`;

export class ContentStore {
  constructor(rootDirectory, filesystem = nodeFs) {
    this.fs = filesystem;
    this.root = path.resolve(rootDirectory);
    this.recordsDirectory = path.join(this.root, "records");
    this.revisionsDirectory = path.join(this.root, "revisions");
    this.mediaDirectory = path.join(this.root, "media");
    this.stagingDirectory = path.join(this.root, "staging");
    this.trashDirectory = path.join(this.root, "trash");
    this.galleryDirectory = path.join(this.root, "gallery");
    this.galleryFilename = path.join(this.galleryDirectory, "items.json");
    this.settingsDirectory = path.join(this.root, "settings");
    this.siteSettingsFilename = path.join(this.settingsDirectory, "site.json");
    this.logDirectory = path.join(this.root, "logs");
    this.logFilename = path.join(this.logDirectory, "events.jsonl");
    this.writeQueue = Promise.resolve();
    this.initializationPromise = null;
  }

  async atomicJson(filename, value) {
    if (this.fs.atomicJson) return this.fs.atomicJson(filename, value);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await this.fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await this.fs.rename(temporary, filename);
  }

  async exists(filename) {
    try { await this.fs.stat(filename); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  async filesIn(directory) {
    try { return await this.fs.readdir(directory); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async initialize() {
    if (!this.initializationPromise) {
      const initialization = (async () => {
        await Promise.all(
          [
            this.recordsDirectory,
            this.revisionsDirectory,
            this.mediaDirectory,
            this.stagingDirectory,
            this.trashDirectory,
            this.galleryDirectory,
            this.settingsDirectory,
            this.logDirectory,
          ].map((directory) => this.fs.mkdir(directory, { recursive: true })),
        );
        await this.cleanupExpiredStaging();
      })();
      this.initializationPromise = initialization.catch((error) => {
        this.initializationPromise = null;
        throw error;
      });
    }
    await this.initializationPromise;
  }

  async cleanupExpiredStaging() {
    let batchNames;
    try {
      batchNames = await this.fs.readdir(this.stagingDirectory);
    } catch {
      return;
    }

    const cutoff = Date.now() - STAGING_MAX_AGE_MS;
    await Promise.all(
      batchNames.map(async (batchName) => {
        const batchDirectory = path.join(this.stagingDirectory, batchName);
        try {
          const details = await this.fs.stat(batchDirectory);
          let createdAt = details.mtimeMs;
          try {
            const manifest = JSON.parse(
              await this.fs.readFile(path.join(batchDirectory, "manifest.json"), "utf8"),
            );
            const manifestTime = new Date(manifest.createdAt).valueOf();
            if (Number.isFinite(manifestTime)) createdAt = manifestTime;
          } catch {
            // Incomplete batches still expire according to their filesystem time.
          }
          if (createdAt < cutoff) {
            await this.fs.rm(batchDirectory, { recursive: true, force: true });
          }
        } catch {
          // Cleanup is opportunistic and must never prevent the store from starting.
        }
      }),
    );
  }

  serialize(operation) {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.catch(() => {});
    return next;
  }

  recordFilename(lineageId) {
    const safeId = path.posix.basename(cleanRelativePath(lineageId)).replace(/[^a-zA-Z0-9-]/g, "");
    return path.join(this.recordsDirectory, `${safeId}.json`);
  }

  async listRecords({ includeDrafts = true } = {}) {
    const filenames = (await this.filesIn(this.recordsDirectory)).filter((name) => name.endsWith(".json"));
    const records = await Promise.all(
      filenames.map(async (filename) => {
        try {
          return JSON.parse(await this.fs.readFile(path.join(this.recordsDirectory, filename), "utf8"));
        } catch (error) {
          if (error?.code && error.code !== "ENOENT") throw error;
          return null;
        }
      }),
    );
    return records
      .filter((record) => record && (includeDrafts || record.status === "published"))
      .sort(
        (a, b) =>
          new Date(b.displayDate).valueOf() - new Date(a.displayDate).valueOf() ||
          a.title.localeCompare(b.title),
      );
  }

  async getRecord(lineageId, { includeBody = false } = {}) {
    try {
      const record = JSON.parse(await this.fs.readFile(this.recordFilename(lineageId), "utf8"));
      if (!includeBody) return record;
      const source = await this.fs.readFile(resolveStoredPath(this.root, record.currentRevision), "utf8");
      return { ...record, body: parseEntrySource(source, record.sourceFilename).body };
    } catch (error) {
      if (error?.code && error.code !== "ENOENT") throw error;
      return null;
    }
  }

  async appendEvent(event) {
    await this.fs.appendFile(
      this.logFilename,
      `${JSON.stringify({ eventId: randomUUID(), ...event })}\n`,
      "utf8",
    );
  }

  async history(limit = 200) {
    try {
      const lines = (await this.fs.readFile(this.logFilename, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean);
      return lines
        .slice(-Math.max(1, Math.min(Number(limit) || 200, 1000)))
        .reverse()
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (error?.code && error.code !== "ENOENT") throw error;
      return [];
    }
  }

  async historyDetail(eventId) {
    const event = (await this.history(1000)).find((candidate) => candidate.eventId === eventId);
    if (!event) return null;

    const detail = { ...event, changes: Array.isArray(event.changes) ? event.changes : [] };
    if (event.type !== "content_revised" || !event.lineageId || !event.previousHash) {
      return detail;
    }

    const record = await this.getRecord(event.lineageId);
    if (!record) return detail;
    const beforeRevision = record.revisions?.find(
      (revision) => revision.contentHash === event.previousHash,
    );
    const afterRevision = record.revisions?.find(
      (revision) => revision.contentHash === event.contentHash,
    );
    if (!beforeRevision || !afterRevision) return detail;

    try {
      const [beforeSource, afterSource] = await Promise.all([
        this.fs.readFile(resolveStoredPath(this.root, beforeRevision.revisionPath), "utf8"),
        this.fs.readFile(resolveStoredPath(this.root, afterRevision.revisionPath), "utf8"),
      ]);
      const before = parseEntrySource(beforeSource, beforeRevision.sourceFilename, {
        now: beforeRevision.observedAt,
      });
      const after = parseEntrySource(afterSource, afterRevision.sourceFilename, {
        now: afterRevision.observedAt,
      });
      return {
        ...detail,
        changes: historyChanges(before, after),
        diff: diffLines(before.body, after.body),
      };
    } catch {
      return detail;
    }
  }

  async getSiteSettings() {
    try {
      const payload = JSON.parse(await this.fs.readFile(this.siteSettingsFilename, "utf8"));
      return {
        about: typeof payload.about === "string" ? payload.about : DEFAULT_SITE_SETTINGS.about,
        contactEmail:
          typeof payload.contactEmail === "string"
            ? payload.contactEmail
            : DEFAULT_SITE_SETTINGS.contactEmail,
        contactLine:
          typeof payload.contactLine === "string"
            ? payload.contactLine
            : DEFAULT_SITE_SETTINGS.contactLine,
        categories:
          typeof payload.categories === "string"
            ? payload.categories
            : typeof payload.sections === "string"
              ? categoryLines(payload.sections.split(","))
              : DEFAULT_SITE_SETTINGS.categories,
        tabs:
          typeof payload.tabs === "string"
            ? payload.tabs
            : typeof payload.sections === "string"
              ? categoryLines(payload.sections.split(","), false)
              : DEFAULT_SITE_SETTINGS.tabs,
      };
    } catch (error) {
      if (error?.code && error.code !== "ENOENT") throw error;
      return { ...DEFAULT_SITE_SETTINGS };
    }
  }

  async updateSiteSettings(changes = {}) {
    return this.serialize(async () => {
      await this.initialize();
      const existing = await this.getSiteSettings();
      const settings = {
        ...existing,
        about: Object.prototype.hasOwnProperty.call(changes, "about")
          ? String(changes.about ?? "").trim()
          : existing.about,
        contactEmail: Object.prototype.hasOwnProperty.call(changes, "contactEmail")
          ? String(changes.contactEmail ?? "").trim()
          : existing.contactEmail,
        contactLine: Object.prototype.hasOwnProperty.call(changes, "contactLine")
          ? String(changes.contactLine ?? "").trim()
          : existing.contactLine,
        categories: Object.prototype.hasOwnProperty.call(changes, "categories")
          ? categoryLines(String(changes.categories ?? "").split("\n"))
          : existing.categories,
        tabs: Object.prototype.hasOwnProperty.call(changes, "tabs")
          ? categoryLines(String(changes.tabs ?? "").split("\n"), false)
          : existing.tabs,
      };
      const observedAt = new Date().toISOString();
      await this.atomicJson(this.siteSettingsFilename, settings);
      await this.appendEvent({
        at: observedAt,
        type: "site_updated",
        title: "Site details",
        contentHash: contentHash("Site details", JSON.stringify(settings)),
        changes: changesForFields(existing, settings, ["about", "contactEmail", "contactLine", "categories", "tabs"]),
      });
      return settings;
    });
  }

  async listGallery({ includeDrafts = true } = {}) {
    let items = [];
    try {
      const payload = JSON.parse(await this.fs.readFile(this.galleryFilename, "utf8"));
      items = Array.isArray(payload) ? payload : [];
    } catch (error) {
      if (error?.code && error.code !== "ENOENT") throw error;
      items = [];
    }
    return items
      .map(normalizedGalleryItem)
      .filter((item) => includeDrafts || item.status === "published")
      .sort(
        (a, b) =>
          new Date(b.displayDate).valueOf() - new Date(a.displayDate).valueOf() ||
          b.createdAt.localeCompare(a.createdAt),
      );
  }

  async addGalleryItem(file, metadata = {}) {
    return this.serialize(async () => {
      await this.initialize();
      if (!file?.bytes?.length) throw new Error("Choose an image.");
      const title = galleryTitle(metadata.title);
      const id = randomUUID();
      const observedAt = new Date().toISOString();
      const originalName = path.posix.basename(cleanRelativePath(file.name));
      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "-") || "image";
      if (!/\.(?:avif|gif|jpe?g|png|webp)$/i.test(safeName)) {
        throw new Error("Gallery uploads must be a PNG, JPEG, GIF, WebP, or AVIF image.");
      }
      const relativePath = path.join("gallery", id, safeName);
      const destination = path.join(this.mediaDirectory, relativePath);
      await this.fs.mkdir(path.dirname(destination), { recursive: true });
      await this.fs.writeFile(destination, file.bytes);
      const item = {
        id,
        title,
        description: textValue(metadata.description),
        displayDate: normalizedDate(metadata.displayDate, observedAt),
        status: metadata.status === "published" ? "published" : "draft",
        imageHash: createHash("sha256").update(file.bytes).digest("hex"),
        mediaPath: `/media/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`,
        originalName,
        createdAt: observedAt,
        updatedAt: observedAt,
      };
      const items = await this.listGallery();
      items.push(item);
      await this.atomicJson(this.galleryFilename, items);
      await this.appendEvent({
        at: observedAt,
        type: "gallery_added",
        galleryId: id,
        title: item.title || item.originalName,
        contentHash: item.imageHash,
        changes: changesForFields(null, item, [
          "title",
          "description",
          "displayDate",
          "status",
          "originalName",
        ]),
      });
      return item;
    });
  }

  async updateGalleryItem(id, changes = {}) {
    return this.serialize(async () => {
      const items = await this.listGallery();
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Gallery item not found.");
      const existing = items[index];
      const existingFields = { ...existing };
      delete existingFields.caption;
      const updated = {
        ...existingFields,
        title: Object.prototype.hasOwnProperty.call(changes, "title")
          ? galleryTitle(changes.title)
          : existing.title,
        description: Object.prototype.hasOwnProperty.call(changes, "description")
          ? textValue(changes.description)
          : existing.description,
        displayDate: Object.prototype.hasOwnProperty.call(changes, "displayDate")
          ? normalizedDate(changes.displayDate, existing.displayDate)
          : existing.displayDate,
        status: Object.prototype.hasOwnProperty.call(changes, "status")
          ? changes.status === "published"
            ? "published"
            : "draft"
          : existing.status,
        updatedAt: new Date().toISOString(),
      };
      items[index] = updated;
      await this.atomicJson(this.galleryFilename, items);
      await this.appendEvent({
        at: updated.updatedAt,
        type: "gallery_updated",
        galleryId: id,
        title: updated.title || updated.originalName,
        contentHash: updated.imageHash,
        changes: changesForFields(existing, updated, [
          "title",
          "description",
          "displayDate",
          "status",
        ]),
      });
      return updated;
    });
  }

  async inspectUpload(files) {
    await this.initialize();
    const batchId = randomUUID();
    const batchDirectory = path.join(this.stagingDirectory, batchId);
    await this.fs.mkdir(batchDirectory, { recursive: true });
    const storedFiles = [];

    for (const file of files) {
      const filename = cleanRelativePath(file.name);
      const destination = path.join(batchDirectory, filename);
      await this.fs.mkdir(path.dirname(destination), { recursive: true });
      await this.fs.writeFile(destination, file.bytes);
      storedFiles.push(filename);
    }

    return this.reviewStagedFiles(batchId, storedFiles, new Date().toISOString());
  }

  async reviewStagedFiles(batchId, storedFiles, createdAt, previousItems = []) {
    const batchDirectory = path.join(this.stagingDirectory, cleanRelativePath(batchId));
    const records = await this.listRecords();
    const items = [];
    for (const filename of storedFiles.filter((name) => /\.(md|html?)$/i.test(name))) {
      const source = await this.fs.readFile(path.join(batchDirectory, filename), "utf8");
      const entry = parseEntrySource(source, filename, { now: createdAt });
      const exact = records.find((record) => record.contentHash === entry.contentHash);
      const byId = entry.requestedLineageId
        ? records.find((record) => record.lineageId === entry.requestedLineageId)
        : null;
      const bySlug = records.find((record) => record.slug === entry.slug);
      const target = exact || byId || bySlug || null;
      const match = exact ? "exact" : byId ? "lineage" : bySlug ? "slug" : "new";
      const proposal = { ...entry };
      if (target) {
        if (!entry.hasSlug) proposal.slug = target.slug;
        if (!entry.hasDisplayDate) proposal.displayDate = target.displayDate;
        if (!entry.hasType) proposal.type = target.type;
        if (!entry.hasFlower) proposal.flower = target.flower ?? null;
        if (!entry.hasTags) proposal.tags = target.tags || [];
        if (!entry.hasCover) {
          proposal.cover = target.cover || null;
          proposal.coverDescription = target.coverDescription || null;
          proposal.coverShort = target.coverShort || null;
        }
        if (!entry.hasExcerpt) proposal.excerpt = target.excerpt || null;
        if (!entry.hasStatus) proposal.status = target.status;
        if (match === "exact") {
          if (!entry.hasDisplayEditedAt) proposal.displayEditedAt = target.displayEditedAt;
          if (!entry.hasShowEdited) proposal.showEdited = target.showEdited;
        } else {
          if (!entry.hasDisplayEditedAt) proposal.displayEditedAt = createdAt;
          if (!entry.hasShowEdited) proposal.showEdited = true;
        }
      }
      items.push({
        itemId:
          previousItems.find((candidate) => candidate.filename === filename)?.itemId || randomUUID(),
        filename,
        ...proposal,
        match,
        targetLineageId: target?.lineageId || null,
        targetTitle: target?.title || null,
        action: exact ? "reupload" : target ? "revise" : "new",
      });
    }

    // A picture no page in the upload uses is an entry of its own, with the
    // picture as its cover (a picture is content too).
    const used = new Set();
    for (const item of items) {
      for (const asset of referencedAssets(item.body || "", item.filename, [item.cover])) {
        used.add(asset.toLowerCase());
        used.add(path.posix.basename(asset).toLowerCase());
      }
    }
    for (const filename of storedFiles.filter((name) => pictureFile.test(name))) {
      if (used.has(filename.toLowerCase()) || used.has(path.posix.basename(filename).toLowerCase())) continue;
      const entry = parseEntrySource(pictureSource(filename), pictureEntryName(filename), { now: createdAt });
      // The same picture again is the same entry.
      const same = records.find((record) => record.contentHash === entry.contentHash);
      items.push({
        itemId: previousItems.find((candidate) => candidate.filename === filename)?.itemId || randomUUID(),
        filename,
        kind: "picture",
        ...entry,
        ...(same ? { slug: same.slug, type: same.type, tags: same.tags || [], status: same.status, displayDate: same.displayDate } : {}),
        match: same ? "exact" : "new",
        targetLineageId: same?.lineageId || null,
        targetTitle: same?.title || null,
        action: same ? "reupload" : "new",
      });
    }

    const manifest = { batchId, createdAt, files: storedFiles, items };
    await this.atomicJson(path.join(batchDirectory, "manifest.json"), manifest);
    return manifest;
  }

  async readManifest(batchId) {
    const safeBatchId = cleanRelativePath(batchId);
    return JSON.parse(
      await this.fs.readFile(path.join(this.stagingDirectory, safeBatchId, "manifest.json"), "utf8"),
    );
  }

  async listStagedBatches() {
    await this.initialize();
    const manifests = await Promise.all(
      (await this.filesIn(this.stagingDirectory)).map(async (batchName) => {
        try {
          return await this.readManifest(batchName);
        } catch (error) {
          if (error?.code && error.code !== "ENOENT") throw error;
          return null;
        }
      }),
    );
    return manifests
      .filter(Boolean)
      .sort((left, right) => new Date(right.createdAt).valueOf() - new Date(left.createdAt).valueOf())
      .map((manifest) => ({
        batchId: manifest.batchId,
        createdAt: manifest.createdAt,
        fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
        itemCount: Array.isArray(manifest.items) ? manifest.items.length : 0,
        titles: Array.isArray(manifest.items)
          ? manifest.items.map((item) => item.title || item.filename).filter(Boolean)
          : [],
      }));
  }

  async getStagedBatch(batchId) {
    await this.initialize();
    try {
      const manifest = await this.readManifest(batchId);
      return await this.reviewStagedFiles(
        manifest.batchId,
        Array.isArray(manifest.files) ? manifest.files : [],
        manifest.createdAt,
        Array.isArray(manifest.items) ? manifest.items : [],
      );
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async discardStagedBatch(batchId) {
    return this.serialize(async () => {
      await this.initialize();
      const safeBatchId = cleanRelativePath(batchId);
      const manifest = await this.getStagedBatch(safeBatchId);
      if (!manifest) return false;
      await this.fs.rm(path.join(this.stagingDirectory, safeBatchId), { recursive: true, force: true });
      return true;
    });
  }

  async copyEntryAssets(batchId, sourceFilename, body, lineageId, extra = [], stagedFiles = []) {
    const batchDirectory = path.join(this.stagingDirectory, cleanRelativePath(batchId));
    const copied = [];
    const missing = [];
    for (const asset of referencedAssets(body, sourceFilename, extra)) {
      let source = path.join(batchDirectory, asset);
      if (!(await this.exists(source))) {
        // Pictures chosen beside a page rather than in its folder are found by name.
        const name = path.posix.basename(asset).toLowerCase();
        const alike = stagedFiles.filter((file) => path.posix.basename(file).toLowerCase() === name);
        if (alike.length !== 1) {
          missing.push(asset);
          continue;
        }
        source = path.join(batchDirectory, alike[0]);
      }
      const destination = path.join(this.mediaDirectory, lineageId, asset);
      await this.fs.mkdir(path.dirname(destination), { recursive: true });
      await this.fs.copyFile(source, destination);
      copied.push(asset);
    }
    return { copied, missing };
  }

  async commitBatch(batchId, selections) {
    return this.serialize(async () => {
      const safeBatchId = cleanRelativePath(batchId);
      const batchDirectory = path.join(this.stagingDirectory, safeBatchId);
      const manifest = await this.readManifest(batchId);
      const results = [];
      for (const selection of selections) {
        if (selection.action === "skip") continue;
        const item = manifest.items.find((candidate) => candidate.itemId === selection.itemId);
        if (!item) throw new Error("An uploaded item is no longer available.");
        const pictureItem = item.kind === "picture";
        const source = pictureItem
          ? pictureSource(item.filename)
          : await this.fs.readFile(path.join(batchDirectory, item.filename), "utf8");
        const entry = parseEntrySource(source, pictureItem ? pictureEntryName(item.filename) : item.filename, {
          now: manifest.createdAt,
          overrides: selection.overrides || {},
        });
        let targetLineageId =
          selection.action === "new"
            ? null
            : selection.targetLineageId || item.targetLineageId || null;
        const exact = (await this.listRecords()).find(
          (record) => record.contentHash === entry.contentHash,
        );
        if (!targetLineageId && exact) {
          if (selection.action === "new") {
            throw new Error(`“${entry.title}” has the same title and body as an existing entry.`);
          }
          targetLineageId = exact.lineageId;
        }
        if (selection.action !== "new" && !targetLineageId) {
          throw new Error(`The target entry for “${entry.title}” was not found.`);
        }
        if (!targetLineageId) {
          // A new entry whose address is taken gets the next free one: name-2, name-3…
          const taken = new Set((await this.listRecords()).map((record) => record.slug));
          const stem = entry.slug;
          for (let count = 2; taken.has(entry.slug); count += 1) entry.slug = `${stem}-${count}`;
        }
        const result = await this.applyEntry(entry, {
          targetLineageId,
          observedAt: new Date().toISOString(),
          eventHint: selection.action === "reupload" ? "reuploaded" : undefined,
        });
        const assets = await this.copyEntryAssets(batchId, entry.sourceFilename, entry.body, result.lineageId, [entry.cover], manifest.files);
        results.push({ ...result, assets });
      }
      await this.fs.rm(batchDirectory, { recursive: true, force: true });
      return results;
    });
  }

  async applyEntry(entry, options = {}) {
    await this.initialize();
    if (entry.status === "published" && isHtmlBody(entry.body)) {
      const problems = htmlProblems(entry.body);
      if (problems.length > 0) {
        throw Object.assign(
          new Error(
            `“${entry.title}” keeps to the site's look before it can be public. ${problems.length === 1 ? "One thing" : `${problems.length} things`} to change, first: ${problems[0].rule} (${problems[0].text})`,
          ),
          { statusCode: 422, problems },
        );
      }
    }
    const observedAt = options.observedAt || new Date().toISOString();
    const existing = options.targetLineageId
      ? await this.getRecord(options.targetLineageId)
      : null;
    if (options.targetLineageId && !existing) {
      throw new Error("The target entry no longer exists.");
    }
    const lineageId = existing?.lineageId || randomUUID();
    const revisionDirectory = path.join(this.revisionsDirectory, lineageId);
    await this.fs.mkdir(revisionDirectory, { recursive: true });
    const revisionRelative = path.posix.join("revisions", lineageId, `${entry.contentHash}.md`);
    const revisionFilename = resolveStoredPath(this.root, revisionRelative);
    const isContentRevision = Boolean(existing && existing.contentHash !== entry.contentHash);
    const isRepeat = Boolean(existing && existing.contentHash === entry.contentHash);
    const slugCollision = (await this.listRecords()).find(
      (record) => record.slug === entry.slug && record.lineageId !== lineageId,
    );
    if (slugCollision) throw new Error(`The slug “${entry.slug}” is already in use.`);

    if (!(await this.exists(revisionFilename))) {
      await this.fs.writeFile(revisionFilename, canonicalSource(entry, lineageId), "utf8");
    }

    const revisions = existing?.revisions
      ? existing.revisions.map((revision) => ({
          ...revision,
          revisionPath: normalizedStoredPath(revision.revisionPath),
        }))
      : [];
    if (!revisions.some((revision) => revision.contentHash === entry.contentHash)) {
      revisions.push({
        contentHash: entry.contentHash,
        observedAt,
        sourceFilename: entry.sourceFilename,
        revisionPath: revisionRelative,
      });
    }

    const displayDate = existing && !entry.hasDisplayDate ? existing.displayDate : entry.displayDate;
    const displayEditedAt = entry.hasDisplayEditedAt
      ? entry.displayEditedAt
      : isContentRevision
        ? observedAt
        : existing?.displayEditedAt || null;
    const showEdited = entry.hasShowEdited
      ? entry.showEdited
      : isContentRevision
        ? true
        : existing?.showEdited || false;
    const record = {
      version: RECORD_VERSION,
      lineageId,
      slug: entry.slug,
      title: entry.title,
      displayDate: displayDate || observedAt,
      displayEditedAt,
      showEdited,
      type: entry.type,
      flower: entry.flower ?? null,
      tags: entry.tags || [],
      cover: entry.cover || null,
      coverDescription: entry.cover ? entry.coverDescription || null : null,
      coverShort: entry.cover ? entry.coverShort || null : null,
      quietPictures: entry.quietPictures || [],
      excerpt: entry.excerpt || null,
      status: entry.status,
      extras: entry.extras || {},
      contentHash: entry.contentHash,
      createdAt: existing?.createdAt || observedAt,
      importedAt: existing?.importedAt || observedAt,
      lastObservedAt: observedAt,
      contentEditedAt: isContentRevision ? observedAt : existing?.contentEditedAt || null,
      sourceFilename: entry.sourceFilename,
      currentRevision: revisionRelative,
      revisionCount: revisions.length,
      revisions,
    };
    await this.atomicJson(this.recordFilename(lineageId), record);

    const eventType = existing
      ? isContentRevision
        ? "content_revised"
        : options.eventHint || "metadata_updated"
      : options.eventHint || "created";
    await this.appendEvent({
      at: observedAt,
      type: eventType,
      lineageId,
      slug: record.slug,
      title: record.title,
      contentHash: record.contentHash,
      previousHash: isContentRevision ? existing.contentHash : null,
      displayDate: record.displayDate,
      displayEditedAt: record.displayEditedAt,
      showEdited: record.showEdited,
      status: record.status,
      entryType: record.type,
      changes: historyChanges(existing, record),
      repeated: isRepeat,
    });
    return record;
  }

  /**
   * Change the folder tree: `moves` renames or moves a folder (and what is
   * under it) in every entry inside it, or with `to: null` removes it and
   * moves its entries up one level; `categories` is the tree's new order.
   */
  async reorganizeCategories({ categories, tabs, moves = [] } = {}) {
    const changed = [];
    let tabLines = typeof tabs === "string" ? tabs : (await this.getSiteSettings()).tabs;
    for (const move of moves) {
      tabLines = tabLines
        .split("\n")
        .map((line) => {
          const key = categoryKey(categoryPath(line));
          const fromKey = categoryKey(categoryPath(move.from));
          if (!(key === fromKey || key.startsWith(`${fromKey}/`))) return line;
          return move.to === null ? "" : movedType(line, move.from, move.to);
        })
        .join("\n");
    }
    if (moves.length > 0) {
      for (const record of await this.listRecords()) {
        let type = record.type || null;
        for (const move of moves) type = movedType(type, move.from, move.to ?? null);
        if ((type || null) !== (record.type || null)) {
          await this.updateEntry(record.lineageId, { type });
          changed.push(record.lineageId);
        }
      }
    }
    const settings = await this.updateSiteSettings({
      ...(typeof categories === "string" ? { categories } : {}),
      tabs: tabLines,
    });
    return { settings, changed };
  }

  /**
   * A picture or video added to an entry from the dashboard (a cover, or
   * one put in the body). It is kept beside the entry's other files, in
   * images/ or videos/, and the path to write in the entry is returned.
   */
  async addEntryAsset(lineageId, file) {
    await this.initialize();
    const record = await this.getRecord(lineageId);
    if (!record) throw new Error("Entry not found.");
    if (!file?.bytes?.length) throw Object.assign(new Error("Choose a picture or a video."), { statusCode: 400 });
    const original = path.posix.basename(cleanRelativePath(file.name));
    const safe = original.replace(/[^a-zA-Z0-9._-]/g, "-") || "image";
    if (!pictureFile.test(safe)) {
      throw Object.assign(
        new Error(`“${original}” cannot be added: pictures are PNG, JPEG, GIF, WebP, AVIF or SVG, videos MP4, WebM or MOV.`),
        { statusCode: 400 },
      );
    }
    const hash = createHash("sha256").update(file.bytes).digest("hex").slice(0, 8);
    const relative = `${videoFile.test(safe) ? "videos" : "images"}/${hash}-${safe}`;
    const directory = path.posix.dirname((record.sourceFilename || "").replaceAll("\\", "/"));
    const destination = path.join(this.mediaDirectory, lineageId, ...(directory === "." ? [] : directory.split("/")), relative);
    await this.fs.mkdir(path.dirname(destination), { recursive: true });
    await this.fs.writeFile(destination, file.bytes);
    return { path: relative };
  }

  /**
   * Add the example entries (given by the caller: { filename, source }[]) once. A marker in settings
   * remembers that it was done, so removing the examples keeps them gone;
   * an entry whose address is already taken is left as it is.
   */
  async seedExamples(examples) {
    const marker = path.join(this.settingsDirectory, "examples.json");
    let done = null;
    if (await this.exists(marker)) {
      const record = JSON.parse(await this.fs.readFile(marker, "utf8"));
      // An early marker kept no list: everything there was then counts as done.
      done = new Set(record.files || examples.filter((example) => !example.later).map((example) => example.filename));
    }
    done ||= new Set();
    const waiting = examples.filter((example) => !done.has(example.filename));
    if (waiting.length === 0) return 0;
    await this.initialize();
    const taken = new Set((await this.listRecords()).map((record) => record.slug));
    let added = 0;
    for (const example of waiting) {
      done.add(example.filename);
      const entry = parseEntrySource(example.source, example.filename);
      if (taken.has(entry.slug)) continue;
      await this.serialize(() => this.applyEntry(entry, { eventHint: "created" }));
      added += 1;
    }
    await this.atomicJson(marker, { seededAt: new Date().toISOString(), files: [...done] });
    return added;
  }

  /**
   * The gallery used to be a separate list of pictures. Now every picture
   * is in an entry, so each old one becomes an entry of its own (in the
   * folder "pictures"), with the picture as its cover and its title and
   * description as the picture's short and full descriptions. Done once;
   * the old list is left where it was.
   */
  async moveGalleryIntoEntries() {
    const marker = path.join(this.settingsDirectory, "gallery-moved.json");
    if (await this.exists(marker)) return 0;
    await this.initialize();
    const taken = new Set((await this.listRecords()).map((record) => record.slug));
    let moved = 0;
    for (const item of await this.listGallery()) {
      const name = path.posix.basename(decodeURIComponent(item.mediaPath || ""));
      const source = path.join(this.mediaDirectory, "gallery", item.id, name);
      if (!name || !(await this.exists(source))) continue;
      const title = item.title || item.originalName || "picture";
      let slug = slugify(title) || "picture";
      while (taken.has(slug)) slug = `${slug}-${item.id.slice(0, 4)}`;
      taken.add(slug);
      const entry = parseEntrySource("", `${slug}.md`, {
        overrides: {
          title,
          slug,
          type: "pictures",
          displayDate: item.displayDate,
          status: item.status,
          cover: `images/${name}`,
          coverDescription: item.description || item.title || "",
          coverShort: item.title || "",
          body: "",
        },
      });
      const record = await this.serialize(() => this.applyEntry(entry, { eventHint: "created" }));
      const destination = path.join(this.mediaDirectory, record.lineageId, "images", name);
      await this.fs.mkdir(path.dirname(destination), { recursive: true });
      await this.fs.copyFile(source, destination);
      moved += 1;
    }
    await this.atomicJson(marker, { movedAt: new Date().toISOString(), moved });
    return moved;
  }

  /** A new, empty entry written in the dashboard: a draft with a title and, optionally, a folder. */
  async createEntry({ title, type = null, body = "" } = {}) {
    return this.serialize(async () => {
      await this.initialize();
      const name = textValue(title) || "Untitled";
      const taken = new Set((await this.listRecords()).map((record) => record.slug));
      const stem = slugify(name) || "entry";
      let slug = stem;
      for (let count = 2; taken.has(slug); count += 1) slug = `${stem}-${count}`;
      const entry = parseEntrySource("", `${slug}.md`, {
        overrides: { title: name, slug, type: textValue(type) || null, status: "draft", body: String(body || "") },
      });
      return this.applyEntry(entry, { eventHint: "created" });
    });
  }

  /**
   * Take an entry off the site and out of the list. Its record is moved to
   * trash/, with its revisions and pictures left where they are, so it can
   * be brought back by hand.
   */
  async deleteEntry(lineageId) {
    return this.serialize(async () => {
      const record = await this.getRecord(lineageId);
      if (!record) throw new Error("Entry not found.");
      await this.atomicJson(path.join(this.trashDirectory, `${lineageId}.json`), { ...record, deletedAt: new Date().toISOString() });
      await this.fs.rm(this.recordFilename(lineageId), { force: true });
      await this.appendEvent({
        at: new Date().toISOString(),
        type: "deleted",
        lineageId,
        slug: record.slug,
        title: record.title,
        contentHash: record.contentHash,
      });
      return { lineageId };
    });
  }

  async updateEntry(lineageId, changes) {
    return this.serialize(async () => {
      const existing = await this.getRecord(lineageId, { includeBody: true });
      if (!existing) throw new Error("Entry not found.");
      if (changes.expectedLastObservedAt && changes.expectedLastObservedAt !== existing.lastObservedAt) {
        throw Object.assign(new Error("This entry changed in another session. Reopen it before saving; your edits have not been overwritten."), { statusCode: 409 });
      }
      const entry = {
        title: textValue(changes.title) || existing.title,
        slug: slugify(textValue(changes.slug) || existing.slug),
        hasSlug: Object.prototype.hasOwnProperty.call(changes, "slug"),
        displayDate: Object.prototype.hasOwnProperty.call(changes, "displayDate")
          ? normalizedDate(changes.displayDate, existing.displayDate)
          : existing.displayDate,
        hasDisplayDate: Object.prototype.hasOwnProperty.call(changes, "displayDate"),
        displayEditedAt: Object.prototype.hasOwnProperty.call(changes, "displayEditedAt")
          ? optionalDate(changes.displayEditedAt)
          : existing.displayEditedAt,
        hasDisplayEditedAt: Object.prototype.hasOwnProperty.call(changes, "displayEditedAt"),
        showEdited: Object.prototype.hasOwnProperty.call(changes, "showEdited")
          ? Boolean(changes.showEdited)
          : existing.showEdited,
        hasShowEdited: Object.prototype.hasOwnProperty.call(changes, "showEdited"),
        type: Object.prototype.hasOwnProperty.call(changes, "type")
          ? textValue(changes.type) || null
          : existing.type,
        hasType: Object.prototype.hasOwnProperty.call(changes, "type"),
        flower: Object.prototype.hasOwnProperty.call(changes, "flower")
          ? flowerValue(changes.flower)
          : existing.flower ?? null,
        hasFlower: Object.prototype.hasOwnProperty.call(changes, "flower"),
        tags: Object.prototype.hasOwnProperty.call(changes, "tags") ? tagList(changes.tags) : existing.tags || [],
        hasTags: Object.prototype.hasOwnProperty.call(changes, "tags"),
        cover: Object.prototype.hasOwnProperty.call(changes, "cover") ? textValue(changes.cover) || null : existing.cover || null,
        coverDescription: Object.prototype.hasOwnProperty.call(changes, "coverDescription")
          ? textValue(changes.coverDescription) || null
          : existing.coverDescription || null,
        coverShort: Object.prototype.hasOwnProperty.call(changes, "coverShort")
          ? textValue(changes.coverShort) || null
          : existing.coverShort || null,
        hasCover: Object.prototype.hasOwnProperty.call(changes, "cover"),
        quietPictures: Object.prototype.hasOwnProperty.call(changes, "quietPictures")
          ? tagList(changes.quietPictures)
          : existing.quietPictures || [],
        excerpt: Object.prototype.hasOwnProperty.call(changes, "excerpt")
          ? textValue(changes.excerpt) || null
          : existing.excerpt || null,
        hasExcerpt: Object.prototype.hasOwnProperty.call(changes, "excerpt"),
        status: Object.prototype.hasOwnProperty.call(changes, "status")
          ? changes.status === "published"
            ? "published"
            : "draft"
          : existing.status,
        hasStatus: Object.prototype.hasOwnProperty.call(changes, "status"),
        extras: changes.extras || existing.extras || {},
        body: Object.prototype.hasOwnProperty.call(changes, "body")
          ? normalizeBody(changes.body)
          : existing.body,
        sourceFilename: existing.sourceFilename,
      };
      entry.contentHash = contentHash(entry.title, entry.body);
      return this.applyEntry(entry, { targetLineageId: lineageId });
    });
  }
}
