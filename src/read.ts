import path from "node:path";
import {
  allTags,
  categoriesOf,
  entryHref,
  flatten,
  folderAt,
  isAbout,
  keyOf,
  listed,
  pathLabel,
  pathOf,
  picturesOf,
  refersTo,
  shortOf,
  tagsOf,
  withLinks,
  type Category,
  type Path,
} from "./model";
import { filesSourceEnabled, readFilesEntries, readFilesSite } from "./server/files-source.mjs";
import { withStore } from "./server/store.mjs";

/**
 * Reading the site, for public pages: every entry, the folder tree, the
 * tabs, the pictures, the site settings. One reader per request; what it
 * reads it keeps. The source is chosen by the environment:
 *
 *   CURIO_CONTENT_DIR   a folder of files kept in Git (read-only)
 *   POSTGRES_URL        Postgres + Supabase Storage (with the dashboard)
 *   otherwise           a folder on disk, CURIO_DATA_DIR (with the dashboard)
 */

/** One entry as a page shows it. */
export type Entry = {
  /** Shown only to a browser holding the key. */
  private: boolean;
  id: string;
  slug: string;
  title: string;
  /** The date as written for readers ("23 November 2026"), and as an ISO time. */
  date: string;
  dateTime: string;
  year: string;
  editedDate?: string;
  editedDateTime?: string;
  showEdited: boolean;
  /** The folder path, as written ("notes / fieldwork"). */
  folder?: string;
  /** 0–80, or unset. What it means is the design's to say. */
  flower?: number;
  tags: string[];
  cover?: string;
  coverDescription?: string;
  coverShort?: string;
  quietPictures: string[];
  excerpt?: string;
  /** Markdown or HTML (see isHtml); [[links]] are already links. Empty in index(). */
  body: string;
  /** Where files beside the entry are served from: resolveAsset(entry, "images/x.jpg"). */
  assetBase: string;
  sortTime: number;
};

export type SiteSettings = {
  about: string;
  contactEmail: string;
  contactLine: string;
  /** The folder tree's order and empty folders, one path per line. */
  categories: string;
  /** The folders shown as tabs, one path per line. */
  tabs: string;
};

/** A picture as a gallery shows it. */
export type GalleryPicture = {
  id: string;
  src: string;
  full: string;
  short: string;
  /** Whether its short title is put on the picture where it is shown. */
  onPicture: boolean;
  /** Whether it is its entry's cover. */
  cover: boolean;
  slug: string;
  title: string;
  date: string;
};

export type ReaderOptions = {
  /** Include private entries (only for a browser holding the key; see next/getReader). */
  includePrivate?: boolean;
  /** How dates are written. Defaults: "en-GB", the server's time zone. */
  locale?: string;
  timeZone?: string;
  /** Where an entry's page is; used for [[links]] and mentions. Default /writing/<slug>. */
  href?: (slug: string) => string;
};

type Stored = {
  lineageId: string;
  slug: string;
  title: string;
  displayDate: string;
  displayEditedAt?: string | null;
  showEdited?: boolean;
  type?: string | null;
  flower?: number | null;
  tags?: string[];
  cover?: string | null;
  coverDescription?: string | null;
  coverShort?: string | null;
  quietPictures?: string[];
  excerpt?: string | null;
  /** "published" is public; anything else is private. */
  status: string;
  sourceFilename: string;
  mediaRoot?: string;
  body?: string;
};

function dated(value: unknown, locale: string, timeZone?: string) {
  const candidate = new Date(typeof value === "string" || value instanceof Date ? value : Date.now());
  const date = Number.isNaN(candidate.valueOf()) ? new Date() : candidate;
  const format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone });
  return {
    label: format.format(date),
    dateTime: date.toISOString(),
    year: format.formatToParts(date).find((part) => part.type === "year")?.value || String(date.getUTCFullYear()),
    sortTime: date.valueOf(),
  };
}

function mediaBase(record: Stored) {
  const directory = path.posix.dirname(record.sourceFilename.replace(/\\/g, "/"));
  const inside = directory === "." ? [] : directory.split("/");
  const pieces = record.mediaRoot === "files" ? ["files", ...inside] : [record.lineageId, ...inside];
  return `/media/${pieces.map(encodeURIComponent).join("/")}/`;
}

function toEntry(record: Stored, options: ReaderOptions): Entry {
  const locale = options.locale || "en-GB";
  const date = dated(record.displayDate, locale, options.timeZone);
  const edited = record.displayEditedAt ? dated(record.displayEditedAt, locale, options.timeZone) : null;
  return {
    private: record.status !== "published",
    id: record.lineageId,
    slug: record.slug,
    title: record.title,
    date: date.label,
    dateTime: date.dateTime,
    year: date.year,
    sortTime: date.sortTime,
    editedDate: edited?.label,
    editedDateTime: edited?.dateTime,
    showEdited: Boolean(record.showEdited && edited),
    folder: record.type || undefined,
    flower: typeof record.flower === "number" ? record.flower : undefined,
    tags: record.tags || [],
    cover: record.cover || undefined,
    coverDescription: record.coverDescription || undefined,
    coverShort: record.coverShort || undefined,
    quietPictures: record.quietPictures || [],
    excerpt: record.excerpt || undefined,
    body: record.body || "",
    assetBase: mediaBase(record),
  };
}

const newestFirst = (a: Entry, b: Entry) => b.sortTime - a.sortTime || a.title.localeCompare(b.title);

/** A file beside the entry (images/x.png) as an address; addresses and absolute paths are kept. */
export function resolveAsset(entry: Pick<Entry, "assetBase">, value?: string) {
  if (!value || !entry.assetBase || /^(?:[a-z]+:|\/|#)/i.test(value)) return value;
  return `${entry.assetBase}${value.replace(/^\.\//, "")}`;
}

export function createReader(options: ReaderOptions = {}) {
  const href = options.href || entryHref;
  const includeDrafts = Boolean(options.includePrivate);
  const once = <T,>(load: () => Promise<T>) => {
    let value: Promise<T> | undefined;
    return () => (value ||= load());
  };

  const fromFiles = filesSourceEnabled();

  const index = once(async (): Promise<Entry[]> => {
    if (fromFiles) return ((await readFilesEntries()) as Stored[]).map((record) => toEntry({ ...record, body: "" }, options)).sort(newestFirst);
    return withStore(async (store) => ((await store.listRecords({ includeDrafts })) as Stored[]).map((record) => toEntry(record, options)))
      .then((list) => list.sort(newestFirst));
  });

  const entries = once(async (): Promise<Entry[]> => {
    if (fromFiles) return withLinks(((await readFilesEntries()) as Stored[]).map((record) => toEntry(record, options)).sort(newestFirst), href);
    const all = await withStore(async (store) => Promise.all(
      ((await store.listRecords({ includeDrafts })) as Stored[]).map(async (record) => {
        const full = await store.getRecord(record.lineageId, { includeBody: true });
        return toEntry({ ...record, body: full?.body || "" }, options);
      }),
    ));
    return withLinks(all.sort(newestFirst), href);
  });

  const site = once(async (): Promise<SiteSettings> => (fromFiles ? readFilesSite() : withStore((store) => store.getSiteSettings())));

  const tree = once(async (): Promise<Category<Entry>> => {
    const [{ categories }, list] = await Promise.all([site(), index()]);
    const outline: Path[] = String(categories || "").split("\n").map(pathOf).filter((folder) => folder.length > 0);
    return categoriesOf(listed(list.map((entry) => ({ ...entry, type: entry.folder }))), outline) as unknown as Category<Entry>;
  });

  return {
    /** Every entry with its body, newest first (the about entry included; see listed). */
    entries,
    /** Every entry without its body: cheaper, for lists and indexes. */
    index,
    /** Every entry but the about page, newest first. */
    listed: async () => listed((await entries()).map((entry) => ({ ...entry, type: entry.folder }))) as Entry[],
    /** One entry by its address, with its body; undefined when there is none (or it is private and hidden). */
    entry: async (slug: string) => (await entries()).find((entry) => entry.slug === slug),
    /** The about page: the entry whose folder is "about". */
    about: async () => (await entries()).find((entry) => isAbout({ type: entry.folder })),
    /** The entries that link to this one ([[its title]] or its address). */
    mentions: async (slug: string) => (await entries()).filter((entry) => entry.slug !== slug && refersTo(entry.body, slug, href)),
    site,
    /** The folder tree, with each entry in its folder (see model: categoriesOf). */
    tree,
    /** The folder at a page's path segments (/notes/fieldwork), or undefined. */
    folder: async (segments: string[]) => folderAt(await tree(), segments),
    /** The folders chosen to be tabs, in the tree's order. */
    tabs: async () => {
      const [{ tabs }, root] = await Promise.all([site(), tree()]);
      const chosen = new Set(String(tabs || "").split("\n").map((line) => keyOf(pathOf(line))).filter(Boolean));
      return flatten(root).map(({ node }) => node).filter((node) => chosen.has(node.key));
    },
    /** Every tag in use, most used first. */
    tags: async () => allTags(listed((await index()).map((entry) => ({ ...entry, type: entry.folder })))),
    /** Every picture in the entries (not videos), newest entry first, each entry's cover first. */
    pictures: async (): Promise<GalleryPicture[]> =>
      ((await entries()).filter((entry) => !isAbout({ type: entry.folder }))).flatMap((entry) =>
        picturesOf(entry).flatMap((picture, at) => (picture.video ? [] : [{
          id: `${entry.slug}-${at + 1}`,
          src: resolveAsset(entry, picture.src) || picture.src,
          full: picture.full,
          short: shortOf(picture),
          onPicture: picture.onPicture,
          cover: picture.cover,
          slug: entry.slug,
          title: entry.title,
          date: entry.date,
        }])),
      ),
    /**
     * Search and tags, as an index page uses them: entries (not the about
     * page) whose title, folder or tags hold every word, and that have every tag.
     */
    search: async (words: string, tags: string[] = []) => {
      const wanted = words.toLowerCase().split(/\s+/).filter(Boolean);
      const chosen = tags.map((tag) => tag.toLowerCase());
      return listed((await index()).map((entry) => ({ ...entry, type: entry.folder }))).filter((entry) => {
        const text = [entry.title, pathLabel(pathOf(entry.folder)), ...tagsOf(entry).map((tag) => `#${tag}`)].join(" ").toLowerCase();
        return wanted.every((word) => text.includes(word)) && chosen.every((tag) => tagsOf(entry).some((own) => own.toLowerCase() === tag));
      }) as Entry[];
    },
  };
}

export type Reader = ReturnType<typeof createReader>;
