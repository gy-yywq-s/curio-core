# curio-core

Everything a small personal writing site needs behind its pages, without the
pages' design. You bring the look; curio-core brings:

- **Entries**: the only kind of content. A Markdown or HTML body, a title,
  a date, one folder, tags, an excerpt, a cover, and public or private.
- **Folders, tabs and tags**: one tree of folders (any depth); some
  folders chosen as tabs; flat tags for narrowing.
- **Pictures and videos** beside each entry, every picture with a full
  description and an optional short title; a gallery of all of them.
- **Links between entries** (`[[Title]]`) and "mentioned in".
- **Private entries**, shown on the public site only in a browser holding a
  key: a question and answer you set.
- **History** of every change, with diffs; nothing is ever overwritten.
- **Imports** of whole folders of Markdown/HTML with their pictures,
  reviewed before anything is saved.
- **A dashboard API** with a typed client, so your own dashboard is just a
  few forms.
- **Three places to keep it**: a folder of files in Git (no dashboard at
  all), a folder on disk, or Postgres + Supabase Storage.

It is the engine of a real site, taken out as it is; only the design was
left behind. The example in `examples/site` is deliberately plain, so you
can see what is yours to make.

## What you make

A site is a few pages that read, two API routes that are one line each, and
(if you want one) a dashboard.

| page | reads | needed |
| --- | --- | --- |
| `/` home | `reader.listed()` | yes |
| `/writing/[slug]` an entry | `reader.entry(slug)`, `reader.mentions(slug)`, `<EntryBody>` | yes |
| `/[...folder]` a folder | `reader.folder(segments)` | if you use folders |
| `/everything` the index | `reader.tree()`, `reader.tags()`, `reader.search(q, tags)` | optional |
| `/about` | `reader.about()` | optional |
| `/gallery` | `reader.pictures()` | optional |
| `/key` the key to private entries | `keyQuestion()`, `answerKey()` | if you use private entries |
| `/dash` your dashboard | `dash.*` from `curio-core/client` | not with a Git folder |
| layout | `reader.tabs()`, `reader.site()`, `keyHolder()` | yes |

```ts
// pages/api/dash/[...path].ts — the dashboard's API, at /dash/api/*
import { dashHandler } from "curio-core/next/dash";
export const config = { api: { bodyParser: false, responseLimit: "8mb" }, maxDuration: 60 };
export default dashHandler();
```

```ts
// pages/api/media/[...path].ts — pictures and videos, at /media/*
import { mediaHandler } from "curio-core/next/media";
export default mediaHandler();
```

```js
// next.config.mjs
import { withCurio } from "curio-core/next/config";
export default withCurio({ /* your own settings */ });
```

That is all of the back end. Nothing in it needs changing.

## Try it

```bash
pnpm install
pnpm example          # a folder on disk, with the dashboard at /dash (local only)
pnpm example:files    # the same pages, read from examples/site/content (Git mode)
```

Then open <http://127.0.0.1:3000>. In the first, start at `/dash`.

## Where the content is kept

Chosen by environment variables; the pages do not change.

### A folder in Git (no dashboard)

```bash
CURIO_CONTENT_DIR=content
```

Every `.md` or `.html` file under the folder is an entry; files beside it
(`images/x.jpg`, `videos/x.mp4`) are its pictures and videos, served from
`/media/files/<folder>/`. Write, commit, push; your host redeploys. An
optional `site.json` holds the settings:

```json
{
  "contactEmail": "you@example.com",
  "contactLine": "Write to {email}.",
  "categories": ["notes", "notes / fieldwork"],
  "tabs": ["notes"]
}
```

Names starting with `_` or `.` are skipped, and so is `README.md`. Private
entries are never read in this mode (there is no key), so keep private
writing out of a public repository.

### A folder on disk

```bash
CURIO_DATA_DIR=/var/data/curio     # default: .curio-data
```

For a server with a disk. Everything is plain files (see "Portability").

### Postgres + Supabase Storage

```bash
POSTGRES_URL=postgres://…           # a pooled connection is fine
SUPABASE_URL=https://….supabase.co
SUPABASE_SERVICE_ROLE_KEY=…         # or SUPABASE_SECRET_KEY; server only
CURIO_STORAGE_NAMESPACE=site_prod   # required: names this site's data
```

For serverless hosts (Vercel). Documents live in `curio_private.documents`
(a schema outside Supabase's public Data API); files in a private bucket
`curio-<namespace>`, created on first use. Every dashboard request runs in
one transaction under a lock, and is rolled back if it fails. Uploads go
from the browser straight to Storage through short-lived signed addresses,
so a function's body limit never applies (64 MB at a time, set in
`src/server/direct-uploads.mjs` and the bucket's file size limit). Videos
are handed to readers as signed Storage addresses, so they stream and
seek without passing through a function.

Use one namespace per site or environment (`site_dev`, `site_prod`): two
sites can share a database and never see each other's entries.

## Reading: `curio-core/read` and `curio-core/next/reader`

In a Next.js page:

```tsx
import { getReader } from "curio-core/next/reader";

export default async function Home() {
  const reader = await getReader();   // one per request; private entries only for a key holder
  const entries = await reader.listed();
  …
}
```

`configureReader({ locale, timeZone, href })` sets how dates are written
and where an entry's page is (default `/writing/<slug>`; used for
`[[links]]` and mentions). Outside Next.js, `createReader(options)` from
`curio-core/read` is the same object.

| method | gives |
| --- | --- |
| `entries()` | every entry with its body, newest first (the about entry included) |
| `index()` | every entry without bodies (cheaper, for lists) |
| `listed()` | every entry but the about page, with bodies |
| `entry(slug)` | one entry, or `undefined` |
| `about()` | the entry whose folder is `about` |
| `mentions(slug)` | entries that link to this one |
| `tree()` | the folder tree: `{ name, path, key, entries, children }` |
| `folder(segments)` | the folder at `/a/b` (URL segments), or `undefined` |
| `tabs()` | the folders chosen as tabs, in the tree's order |
| `tags()` | every tag in use, most used first: `{ name, count }` |
| `search(words, tags)` | entries whose title, folder or tags hold every word and that have every tag |
| `pictures()` | every picture (not videos), newest entry first: `{ src, full, short, onPicture, cover, slug, title, date }` |
| `site()` | `{ about, contactEmail, contactLine, categories, tabs }` |

An `Entry` has `slug`, `title`, `date` (written), `dateTime` (ISO),
`year`, `editedDate`/`showEdited`, `folder` (`"notes / fieldwork"`),
`tags`, `flower` (0–80 or unset; what it means is yours to decide),
`cover`, `coverDescription`, `coverShort`, `quietPictures`, `excerpt`,
`body`, `private`, and `assetBase`. `resolveAsset(entry, "images/x.jpg")`
turns a file beside the entry into its address.

The model's helpers come from `curio-core`: `pathOf`, `pathLabel`,
`folderHref`, `tagsOf`, `isHtml`, `isVideo`, `picturesOf`, `shortOf`,
`flatten`, `countIn`, `categoriesOf`, `withLinks`, `refersTo`.

### Bodies: `curio-core/react`

```tsx
import { EntryBody } from "curio-core/react";
<EntryBody entry={entry} />
```

Markdown (GitHub-flavoured, `$maths$` with KaTeX: import
`katex/dist/katex.min.css` once) or HTML, with files beside the entry
resolved. It sets no style, only class names: `.entry-body`
(`.entry-body--html`), `.entry-picture`, `.entry-picture-caption`,
`.entry-video`. External links open in a new tab.

## Writing an entry

```markdown
---
title: How a shore holds still
date: 2026-11-14
folder: notes / fieldwork
tags: [water, walking]
flower: 45
excerpt: Three mornings at the same spot on the lake.
cover:
  src: images/lake.jpg
  description: Mountains under heavy cloud, mirrored in a still lake.
  short: Still lake
status: public
---

The first morning the water was so flat…

![The far bank doubled in the water.](images/lake.jpg "Still lake")
![What the video shows.](videos/drift.mp4)

See also [[Horizon exercise]].
```

| field | meaning | when absent |
| --- | --- | --- |
| `title` | Title. | The first `# heading` (removed from the body), else the file name. |
| `date` | Public date. | A leading `YYYY-MM-DD` in the file name, else the upload time. |
| `folder` (or `type`) | One folder path, names separated by `/`. `about` makes the entry the about page. | No folder. |
| `tags` | A list, or a comma-separated line. | No tags. |
| `flower` | A number 0–80 for your design to use. | Unset. |
| `excerpt` | A line or two for lists. | None. |
| `cover` | A path or address, or `{ src, description, short }`. | No cover. |
| `quietPictures` | Pictures (paths as written) whose short title is kept off the picture. | Every short title may be put on its picture. |
| `status` | `public` or `private` (`published`/`draft` are read too). | `private`. |
| `edited`, `show_edited` | A public "edited on" date, and whether to show it. | Set on real revisions. |
| `slug` | The entry's address. | From the file name. |

Paths are relative to the file.

- **Pictures** have two descriptions: the full one (`alt`, always write
  it) and an optional short title (`title`). In HTML: `<img alt title>`.
- **Videos** (`.mp4`, `.m4v`, `.webm`, `.mov`) are written as pictures
  are, or `<video src controls>` in HTML; they play where they stand and
  are not in the gallery. MP4 (H.264) plays everywhere.
- **Links**: `[[Title]]` or `[[Title|the words to show]]` (a slug works
  too); a name that matches nothing is left as words.
- **HTML bodies**: a body that begins with a block tag (`<section>`,
  `<div>`, `<p>`, `<figure>`, `<style>`, `<script>`…) is HTML. Its scripts
  run once the page is ready, and can draw in the site's look through
  `window.curio`: `color(name, alpha?)` reads `--<name>` from `:root`,
  `font(rem, family?)` reads `--sans`/`--serif`/`--mono`, plus `scale`
  and `reducedMotion`.
- **HTML rules**: a public HTML entry keeps its styles to its own class or
  id, and may not set its own colours, fonts, px type sizes, shadows,
  gradients or variables (it uses the site's CSS variables), nor reach
  outside its own elements from a script, so it cannot break your design; one that does saves as private and the error
  lists what to change. Replace the rules with `setHtmlRules(fn)` or turn
  them off with `setHtmlRules(null)` (from `curio-core/server`).

## Your dashboard: `curio-core/client`

Every call goes to `/dash/api/*` on the same site and needs the owner's
access.

```ts
import { dash } from "curio-core/client";

const entry = await dash.create({ title: "A first entry", type: "notes" });
const { path } = await dash.addFile(entry.lineageId, file);   // "images/1a2b3c4d-lake.jpg"
await dash.save(entry.lineageId, {
  body: `Hello.\n\n![A lake under cloud.](${path} "Still lake")`,
  status: "published",
  expectedLastObservedAt: entry.lastObservedAt,   // refuses to save over a newer save (409)
});
```

| call | does |
| --- | --- |
| `entries()` / `entry(id)` | every entry (no bodies) / one with its body |
| `create({ title, type?, body? })` | a new private entry |
| `save(id, changes)` | saves any fields; a new revision only when title or body changed |
| `remove(id)` | moves the entry to the trash (its history stays) |
| `addFile(id, file)` | a picture or video beside the entry; gives the path to write |
| `inspectImport(files)` → `commitImport(batchId, items)` | an import, reviewed first; `unfinishedImports()`, `discardImport(id)` |
| `history(limit?)` / `historyEvent(id)` | every change, newest first / one with its diff |
| `site()` / `saveSite(changes)` | the site settings |
| `organize({ categories?, tabs?, moves? })` | the folder tree's order, the tabs, folders moved or renamed (their entries follow) |
| `key()` / `saveKey({ question, answer? })` | the key to private entries (an empty question removes it) |

`examples/site/app/dash/dash.tsx` is a whole (plain) dashboard in about a
hundred lines. Before sending, a good dashboard also prepares pictures:
HEIC to JPEG, very large photographs scaled down.

## Who may use the dashboard

`canAccessDashboard(headers)` (used by `dashHandler`, `mediaHandler` and
`canOpenDash`) allows, in order:

1. `VERCEL_ENV=preview` with `CURIO_DASH_AUTH=vercel-preview`: a preview
   behind Vercel Authentication.
2. `VERCEL_ENV=production` with `CURIO_DASH_AUTH=vercel-protected`, on a
   `*.vercel.app` address: a production site that is itself behind Vercel
   Authentication (not yet public). Remove it before making the site public.
3. `DASH_AUTH_BYPASS=true` on a loopback address, not on Vercel: local
   development.
4. Cloudflare Access: `CLOUDFLARE_ACCESS_TEAM_DOMAIN` and
   `CLOUDFLARE_ACCESS_AUD`; the signed assertion Cloudflare adds is
   verified here, so the site's other addresses cannot get round it.

Anything else is refused. To use your own login, pass
`dashHandler({ authorize })`, `mediaHandler({ authorize })` and
`canOpenDash(authorize)` a function from request headers to a boolean.

## Private entries

A private entry is in the dashboard, and on the public site only in a
browser holding the key. The key is a question and its answer, set with
`dash.saveKey`. Your `/key` page shows `keyQuestion()` and calls
`answerKey(answer)` from a server action: the right answer (case and
spaces do not matter) gives the browser a signed cookie for 90 days;
`hideKey()` puts it away. The answer is kept only as a salted hash, a new
answer turns every earlier cookie away, and after six wrong answers in a
quarter of an hour nothing is taken until it has passed. Their pictures
and videos are served to the same browsers. It is a light lock, for
readers who should not happen on private things; anyone who knows the
answer can read them.

## Portability

Every entry is kept as the Markdown or HTML it was written in (with its
front matter), each revision as its own file, beside its pictures:

```
records/<id>.json            the entry's current state
revisions/<id>/<hash>.md     every revision of its text, named by its content
media/<id>/images/…          its files
settings/site.json           the site settings
logs/events.jsonl            the history
```

On Postgres the same paths are rows, and files are Storage objects. A
folder in Git uses the same front matter, so moving between the three is a
matter of copying files.

## Developing curio-core

```bash
pnpm test        # Node tests: store, imports, history, keys, Postgres (in-process), Git folder
pnpm typecheck
```

The package is TypeScript and ES modules, compiled by the app that uses
it (`withCurio` adds it to `transpilePackages`).

## Licence

MIT.
