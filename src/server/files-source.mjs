import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseEntrySource } from "./content-store.mjs";

/**
 * The read-only source: a folder of entries kept in Git. Each Markdown
 * (.md) or HTML (.html) file is one entry, with the same front matter the
 * dashboard writes; files beside it (images/x.jpg, videos/x.mp4) are its
 * pictures and videos, served from /media/files/<its folder>/. An optional
 * site.json in the folder holds the site settings. Push to the repository
 * and redeploy: there is no dashboard and nothing is written.
 *
 * Files and folders whose names start with "_" or "." are skipped, and so
 * is README.md.
 */
export function contentDirectory() {
  return process.env.CURIO_CONTENT_DIR ? path.resolve(process.env.CURIO_CONTENT_DIR) : null;
}

export function filesSourceEnabled() {
  return Boolean(contentDirectory());
}

async function walk(root, relative = "") {
  const found = [];
  for (const name of await readdir(path.join(root, relative))) {
    if (name.startsWith("_") || name.startsWith(".") || name === "node_modules") continue;
    const inner = relative ? `${relative}/${name}` : name;
    const info = await stat(path.join(root, inner));
    if (info.isDirectory()) found.push(...(await walk(root, inner)));
    else if (/\.(?:md|html?)$/i.test(name) && name.toLowerCase() !== "readme.md") found.push(inner);
  }
  return found;
}

const lines = (value) => (Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "");

/** The site settings from site.json (all optional): about, contactEmail, contactLine, categories, tabs. */
export async function readFilesSite(root = contentDirectory()) {
  try {
    const payload = JSON.parse(await readFile(path.join(root, "site.json"), "utf8"));
    return {
      about: typeof payload.about === "string" ? payload.about : "",
      contactEmail: typeof payload.contactEmail === "string" ? payload.contactEmail : "",
      contactLine: typeof payload.contactLine === "string" ? payload.contactLine : "",
      categories: lines(payload.categories),
      tabs: lines(payload.tabs),
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { about: "", contactEmail: "", contactLine: "", categories: "", tabs: "" };
  }
}

/**
 * Every entry in the folder, as stored records with their bodies (the same
 * shape ContentStore.listRecords + getRecord give). Private entries are
 * never read from Git: there is no key to show them with.
 */
export async function readFilesEntries(root = contentDirectory()) {
  const seen = new Set();
  const entries = [];
  for (const file of (await walk(root)).sort()) {
    const [source, info] = await Promise.all([readFile(path.join(root, file), "utf8"), stat(path.join(root, file))]);
    const entry = parseEntrySource(source, file, { now: info.mtime.toISOString() });
    if (entry.status !== "published") continue;
    if (seen.has(entry.slug)) {
      console.warn(`[curio] ${file}: another entry already has the address "${entry.slug}"; skipped.`);
      continue;
    }
    seen.add(entry.slug);
    entries.push({ ...entry, lineageId: `files:${file}`, sourceFilename: file, mediaRoot: "files" });
  }
  return entries;
}
