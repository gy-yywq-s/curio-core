/**
 * Where an entry lives: one path in a tree of folders the author makes,
 * written with "/" between names, like a file's place on a disk:
 *
 *   notes / fieldwork / 01
 *
 * A folder is known by its whole path, so "memo / 01" and "script / 01"
 * are two different folders that happen to share a last name. Every
 * folder has its own page at its path (/notes/fieldwork). Some folders,
 * at any level, are chosen in the dashboard to be tabs: that only puts
 * them in the site's navigation. "everything" is the whole tree.
 *
 * Tags are separate and flat (see tagsOf): any number per entry, with no
 * place in the tree. They only narrow lists.
 *
 * The tree's order, and folders that hold nothing yet, are kept in the
 * dashboard's folder list; any folder entries use that the list lacks is
 * added after it, in the order entries first use it.
 */
export type Path = string[];

const reserved = new Set(["home", "everything", "about"]);

/** A path's identity: its names, lower-cased, joined by "/". */
export const keyOf = (path: Path) => path.map((name) => name.trim().toLowerCase()).join("/");

/** The path written in a line like "a / b / c" (none for the about page or a reserved name). */
export function pathOf(text: string | null | undefined): Path {
  const path = (text || "").split("/").map((name) => name.trim()).filter(Boolean);
  return path.length > 0 && reserved.has(path[0].toLowerCase()) ? [] : path;
}

/** A path as it is shown. */
export const pathLabel = (path: Path) => path.join(" / ");

/** An entry's tags: flat names, each once, in the order written. */
export function tagsOf(entry: { tags?: string[] | null }): string[] {
  const seen = new Set<string>();
  return (entry.tags || [])
    .map((tag) => tag.trim())
    .filter((tag) => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase()));
}

/** Every tag in use, most used first. */
export function allTags(entries: Array<{ tags?: string[] | null }>) {
  const counts = new Map<string, { name: string; count: number }>();
  for (const entry of entries) {
    for (const tag of tagsOf(entry)) {
      const known = counts.get(tag.toLowerCase());
      if (known) known.count += 1;
      else counts.set(tag.toLowerCase(), { name: tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type Category<T> = { name: string; path: Path; key: string; entries: T[]; children: Category<T>[] };

/** The whole tree, with each entry in its folder. */
export function categoriesOf<T extends { type?: string | null }>(entries: T[], outline: Path[] = []): Category<T> {
  const root: Category<T> = { name: "", path: [], key: "", entries: [], children: [] };
  const known = new Map<string, Category<T>>([["", root]]);
  const place = (path: Path) => {
    let node = root;
    path.forEach((name, depth) => {
      const key = keyOf(path.slice(0, depth + 1));
      let next = known.get(key);
      if (!next) {
        next = { name, path: path.slice(0, depth + 1), key, entries: [], children: [] };
        known.set(key, next);
        node.children.push(next);
      }
      node = next;
    });
    return node;
  };
  for (const line of outline) {
    const path = pathOf(line.join("/"));
    if (path.length > 0) place(path);
  }
  for (const entry of entries) {
    const path = pathOf(entry.type);
    if (path.length > 0) place(path).entries.push(entry);
  }
  return root;
}

/** Every category under a node, depth first, with how deep it is. */
export function flatten<T>(node: Category<T>, depth = 0): Array<{ node: Category<T>; depth: number }> {
  return node.children.flatMap((child) => [{ node: child, depth }, ...flatten(child, depth + 1)]);
}

/** How many entries are in a folder or anywhere under it. */
export function countIn<T>(node: Category<T>): number {
  return node.entries.length + node.children.reduce((sum, child) => sum + countIn(child), 0);
}

/** Whether a path is a folder or inside it. */
export const within = (path: Path, folder: Path) =>
  folder.length > 0 && keyOf(path.slice(0, folder.length)) === keyOf(folder) && path.length >= folder.length;

/** A folder's own page: its path, each name lower-cased with hyphens for spaces. */
export const slugOf = (name: string) => name.trim().toLowerCase().replace(/\s+/g, "-");
export const folderHref = (path: Path) => `/${path.map((name) => encodeURIComponent(slugOf(name))).join("/")}`;

/** The folder at an address's segments, if there is one. */
export function folderAt<T>(tree: Category<T>, segments: string[]): Category<T> | undefined {
  let node: Category<T> | undefined = tree;
  for (const segment of segments) {
    const wanted = slugOf(decodeURIComponent(segment));
    node = node.children.find((child) => slugOf(child.name) === wanted);
    if (!node) return undefined;
  }
  return node === tree ? undefined : node;
}

/** The entry whose type is "about" is the about page, not part of the lists. */
export function isAbout(entry: { type?: string | null }) {
  return (entry.type || "").trim().toLowerCase() === "about";
}

export function listed<T extends { type?: string }>(entries: T[]) {
  return entries.filter((entry) => !isAbout(entry));
}

/**
 * An entry is written one of two ways. Markdown is the default. A body that
 * begins with a block-level HTML tag is HTML and is set as written (see the
 * README for the rules that keep it in the site's style).
 */
export function isHtml(body: string) {
  return /^\s*<(article|section|div|figure|header|main|style|p|h[1-6]|table|ul|ol|details|script)\b/i.test(body);
}

/**
 * Links between entries, written [[Title]] or [[Title|the words to show]]
 * (a slug works in place of a title). Each becomes an ordinary link to
 * that entry; a name that matches nothing is left as plain words.
 */
export const entryHref = (slug: string) => `/writing/${slug}`;

export function withLinks<T extends { slug: string; title: string; body: string }>(entries: T[], href: (slug: string) => string = entryHref): T[] {
  const find = (name: string) => {
    const wanted = name.trim().toLowerCase();
    return entries.find((entry) => entry.title.toLowerCase() === wanted || entry.slug.toLowerCase() === wanted);
  };
  return entries.map((entry) => {
    if (!entry.body.includes("[[")) return entry;
    const html = isHtml(entry.body);
    const body = entry.body.replace(/\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]/g, (_, name: string, words?: string) => {
      const target = find(name);
      const label = (words || name).trim();
      if (!target) return label;
      return html ? `<a href="${href(target.slug)}">${label}</a>` : `[${label}](${href(target.slug)})`;
    });
    return { ...entry, body };
  });
}

/** Whether a body (after withLinks) links to the entry at href(slug). */
export function refersTo(body: string, slug: string, href: (slug: string) => string = entryHref) {
  const escaped = href(slug).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\]\\(\\s*|href=["'])(?:https?://[^/)\\s"']+)?${escaped}(?:\\s*[)#?\\s"']|$)`).test(body);
}

/**
 * Pictures. Every picture on the site is in an entry: its cover, or one in
 * its body. Each has two descriptions: the full one, which every picture
 * should have, and a short one, put on the picture and under it in the
 * gallery; left empty, the picture has none. They are
 * written where the picture is:
 *
 *   Markdown   ![the full description](images/x.jpg "the short one")
 *   HTML       <img src="images/x.jpg" alt="the full description" title="the short one">
 *   cover      cover: { src: images/x.jpg, description: …, short: … }
 *
 * The gallery shows them all, newest entry first, each leading back to
 * its entry.
 *
 * A video is written as a picture is, its file uploaded beside the entry:
 * `![what it shows](videos/x.mp4)` in Markdown, `<video src="videos/x.mp4"
 * controls>` in HTML. It is played where it stands; it is not in the
 * gallery, but a frame of it can be taken as the entry's cover.
 */
export type Picture = { src: string; full: string; short: string; video?: boolean };

/** Whether a file is a video, by its name: MP4, M4V, WebM or QuickTime. */
export const isVideo = (src: string) => /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(src);

/** The videos an entry's body plays, in order. */
export function bodyVideos(body: string): string[] {
  if (isHtml(body)) {
    return [...body.matchAll(/<(?:video|source)\b[^>]*>/gi)].map(([tag]) => attribute(tag, "src")).filter((src) => src && isVideo(src));
  }
  return bodyPictures(body).filter((picture) => picture.video).map((picture) => picture.src);
}

const markdownPicture = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g;
const htmlPicture = /<img\b[^>]*>/gi;
const attribute = (tag: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag)?.[2] ?? "";

/** The pictures in a body, in order. */
export function bodyPictures(body: string): Picture[] {
  if (isHtml(body)) {
    return [...body.matchAll(htmlPicture)].map(([tag]) => ({
      src: attribute(tag, "src"),
      full: attribute(tag, "alt"),
      short: attribute(tag, "title"),
    })).filter((picture) => picture.src);
  }
  return [...body.matchAll(markdownPicture)].map((match) => ({
    src: match[2],
    full: match[1],
    short: match[3] || "",
    video: isVideo(match[2]),
  }));
}

/** A body with its `index`th picture's descriptions changed. */
export function withPictureText(body: string, index: number, text: { full: string; short: string }) {
  let seen = -1;
  const clean = (value: string) => value.replace(/[\n\r]+/g, " ");
  if (isHtml(body)) {
    const quote = (value: string) => clean(value).replace(/"/g, "&quot;");
    return body.replace(htmlPicture, (tag) => {
      seen += 1;
      if (seen !== index) return tag;
      let next = tag.replace(/\s(alt|title)\s*=\s*(["'])[\s\S]*?\2/gi, "");
      next = next.replace(/<img\b/i, `<img alt="${quote(text.full)}"${text.short ? ` title="${quote(text.short)}"` : ""}`);
      return next;
    });
  }
  return body.replace(markdownPicture, (whole, _full: string, src: string) => {
    seen += 1;
    if (seen !== index) return whole;
    const full = clean(text.full).replace(/[[\]]/g, "");
    const short = clean(text.short).replace(/"/g, "”");
    return `![${full}](${src}${short ? ` "${short}"` : ""})`;
  });
}

/** The short title, as written. Left empty, the picture has none: nothing is put on it. */
export function shortOf(picture: Picture) {
  return picture.short.trim();
}

/**
 * An entry's pictures: its cover first, then those in its body. Each says
 * whether its short title is put on it (`onPicture`): yes, unless the entry
 * lists the picture's file in `quietPictures`. The short title is the
 * picture's title all the same (under it in the gallery, over its full
 * description in the viewer); this only keeps it off the picture itself.
 */
export function picturesOf(entry: {
  cover?: string | null;
  coverDescription?: string | null;
  coverShort?: string | null;
  quietPictures?: string[] | null;
  body?: string;
}): Array<Picture & { cover: boolean; onPicture: boolean }> {
  const quiet = new Set((entry.quietPictures || []).map((src) => src.trim().toLowerCase()));
  return [
    ...(entry.cover ? [{ src: entry.cover, full: entry.coverDescription || "", short: entry.coverShort || "", cover: true }] : []),
    ...bodyPictures(entry.body || "").map((picture) => ({ ...picture, cover: false })),
  ].map((picture) => ({ ...picture, onPicture: !quiet.has(picture.src.trim().toLowerCase()) }));
}
