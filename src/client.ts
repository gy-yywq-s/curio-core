/**
 * The dashboard's API from a browser, for building your own dashboard.
 * Every call goes to /dash/api/* on the same site (dashHandler) and needs
 * the owner's access; errors are thrown with the server's message.
 *
 *   import { dash } from "curio-core/client";
 *   const entries = await dash.entries();
 *   const entry = await dash.create({ title: "A first entry", type: "notes" });
 *   await dash.save(entry.lineageId, { body: "Hello.", status: "published", expectedLastObservedAt: entry.lastObservedAt });
 */

/** An entry as the dashboard sees it (a stored record). */
export type StoredEntry = {
  lineageId: string;
  slug: string;
  title: string;
  displayDate: string;
  displayEditedAt?: string | null;
  showEdited?: boolean;
  /** The folder path, "notes / fieldwork". */
  type?: string | null;
  flower?: number | null;
  tags?: string[];
  cover?: string | null;
  coverDescription?: string | null;
  coverShort?: string | null;
  quietPictures?: string[];
  excerpt?: string | null;
  /** private = "draft", public = "published". */
  status: "draft" | "published";
  contentHash: string;
  sourceFilename: string;
  /** When it was last saved; give it back with a save to refuse saving over a newer one. */
  lastObservedAt?: string;
  /** Only from entry(id). */
  body?: string;
};

/** What a save can change; leave out what stays. expectedLastObservedAt refuses a save over a newer one (409). */
export type EntryChanges = Partial<Pick<StoredEntry,
  "title" | "slug" | "displayDate" | "displayEditedAt" | "showEdited" | "type" | "flower" | "tags" |
  "cover" | "coverDescription" | "coverShort" | "quietPictures" | "excerpt" | "status" | "body">> & {
  expectedLastObservedAt?: string;
};

export type SiteSettings = { about: string; contactEmail: string; contactLine: string; categories: string; tabs: string };

export type ImportItem = {
  itemId: string;
  sourceFilename: string;
  title: string;
  /** "new", "update", "unchanged" or a problem; see the review the server returns. */
  [detail: string]: unknown;
};

async function call<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(endpoint, { ...init, credentials: "same-origin", cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `The request failed (${response.status}).`);
  return payload.data as T;
}

const json = (method: string, value: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

let capabilities: Promise<{ directUploads: boolean }> | undefined;

/**
 * Sends files. With Supabase Storage they go straight to Storage (signed
 * addresses), so a function's body limit never applies; otherwise as a
 * multipart form. `extra` is added to either.
 */
async function send<T>(endpoint: string, files: File[], extra: Record<string, unknown> = {}): Promise<T> {
  capabilities ||= call<{ directUploads: boolean }>("/dash/api/capabilities");
  if ((await capabilities).directUploads) {
    const signed = await call<{ id: string; url: string }[]>("/dash/api/uploads", json("POST", {
      files: files.map((file) => ({ name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, size: file.size })),
    }));
    await Promise.all(signed.map(async ({ url }, at) => {
      const response = await fetch(url, { method: "PUT", headers: { "Content-Type": files[at].type || "application/octet-stream" }, body: files[at] });
      if (!response.ok) throw new Error(`${files[at].name} could not be uploaded.`);
    }));
    return call<T>(endpoint, json("POST", { uploads: signed.map((file) => file.id), ...extra }));
  }
  const form = new FormData();
  for (const file of files) form.append("files", file, (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
  for (const [key, value] of Object.entries(extra)) form.append(key, String(value));
  return call<T>(endpoint, { method: "POST", body: form });
}

const id = (lineageId: string) => encodeURIComponent(lineageId);

export const dash = {
  /** Every entry, private and public, without bodies. */
  entries: () => call<StoredEntry[]>("/dash/api/entries"),
  /** One entry with its body. */
  entry: (lineageId: string) => call<StoredEntry>(`/dash/api/entries/${id(lineageId)}`),
  /** A new, empty, private entry: a title and, optionally, a folder and a body. */
  create: (entry: { title: string; type?: string; body?: string }) => call<StoredEntry>("/dash/api/entries", json("POST", entry)),
  /** Saves changes; a public HTML entry must keep to the HTML rules (the error lists what to change). */
  save: (lineageId: string, changes: EntryChanges) => call<StoredEntry>(`/dash/api/entries/${id(lineageId)}`, json("PATCH", changes)),
  remove: (lineageId: string) => call<unknown>(`/dash/api/entries/${id(lineageId)}`, { method: "DELETE" }),
  /**
   * A picture or video put beside an entry; the result's `path` is what to
   * write in its body (`![full](path "short")`) or its cover.
   */
  addFile: (lineageId: string, file: File) =>
    send<{ path: string; [detail: string]: unknown }>(`/dash/api/entries/${id(lineageId)}/assets`, [file]),

  /** Import: Markdown/HTML files (and pictures/videos beside them) are first reviewed, then committed. */
  inspectImport: (files: File[]) => send<{ batchId: string; items: ImportItem[] }>("/dash/api/import/inspect", files),
  commitImport: (batchId: string, items: Array<{ itemId: string; [choice: string]: unknown }>) =>
    call<unknown>("/dash/api/import/commit", json("POST", { batchId, items })),
  unfinishedImports: () => call<unknown[]>("/dash/api/import/staged"),
  discardImport: (batchId: string) => call<unknown>(`/dash/api/import/staged/${encodeURIComponent(batchId)}`, { method: "DELETE" }),

  /** Every change ever saved, newest first, and one in detail (with its diff). */
  history: (limit = 200) => call<unknown[]>(`/dash/api/history?limit=${limit}`),
  historyEvent: (eventId: string) => call<unknown>(`/dash/api/history/${encodeURIComponent(eventId)}`),

  site: () => call<SiteSettings>("/dash/api/site"),
  saveSite: (changes: Partial<SiteSettings>) => call<SiteSettings>("/dash/api/site", json("PATCH", changes)),
  /**
   * The folder tree at once: its order and empty folders (`categories`,
   * one path per line), the tabs, and folders moved or renamed (`moves`,
   * every entry inside going with them; `to: null` removes the folder).
   */
  organize: (change: { categories?: string; tabs?: string; moves?: Array<{ from: string; to: string | null }> }) =>
    call<{ settings: SiteSettings; changed: string[] }>("/dash/api/categories", json("POST", change)),

  /** The key to private entries: its question, and whether an answer is set. */
  key: () => call<{ question: string; answerSet: boolean }>("/dash/api/key"),
  /** An empty answer keeps the old one; an empty question removes the key. */
  saveKey: (key: { question: string; answer?: string }) => call<{ question: string; answerSet: boolean }>("/dash/api/key", json("PUT", key)),
};
