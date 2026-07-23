"use client";

import { useCallback, useEffect, useState } from "react";
import { dash, type SiteSettings, type StoredEntry } from "curio-core/client";

/**
 * The smallest useful dashboard, to show that the client is all one needs:
 * a list, a new entry, an editor (title, folder, tags, excerpt, visibility,
 * body, a picture or video put in, a cover), the site settings, and the key.
 * Design your own; everything it does is a call on `dash`.
 */
export function Dash() {
  const [entries, setEntries] = useState<StoredEntry[]>([]);
  const [open, setOpen] = useState<StoredEntry | null>(null);
  const [site, setSite] = useState<SiteSettings | null>(null);
  const [key, setKey] = useState({ question: "", answer: "" });
  const [said, setSaid] = useState("");

  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      setSaid(done);
    } catch (error) {
      setSaid(error instanceof Error ? error.message : "That did not work.");
    }
  };
  const refresh = useCallback(async () => setEntries(await dash.entries()), []);

  useEffect(() => {
    void (async () => {
      await refresh();
      setSite(await dash.site());
      const current = await dash.key();
      setKey({ question: current.question, answer: "" });
    })();
  }, [refresh]);

  if (open) {
    const change = (changes: Partial<StoredEntry>) => setOpen({ ...open, ...changes });
    return (
      <section>
        <p><button onClick={() => { setOpen(null); void refresh(); }}>← entries</button> <span className="muted">{said}</span></p>
        <p><label>Title <input value={open.title} onChange={(event) => change({ title: event.target.value })} /></label></p>
        <p><label>Folder <input value={open.type || ""} placeholder="notes / fieldwork" onChange={(event) => change({ type: event.target.value })} /></label></p>
        <p><label>Tags <input value={(open.tags || []).join(", ")} onChange={(event) => change({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) })} /></label></p>
        <p><label>Excerpt <input value={open.excerpt || ""} onChange={(event) => change({ excerpt: event.target.value })} /></label></p>
        <p>
          <label><input type="radio" checked={open.status === "draft"} onChange={() => change({ status: "draft" })} /> private</label>{" "}
          <label><input type="radio" checked={open.status === "published"} onChange={() => change({ status: "published" })} /> public</label>
        </p>
        <p><textarea rows={14} style={{ width: "100%" }} value={open.body || ""} onChange={(event) => change({ body: event.target.value })} /></p>
        <p>
          <label>Put in a picture or video{" "}
            <input type="file" accept="image/*,video/*" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void run(async () => {
                const { path } = await dash.addFile(open.lineageId, file);
                change({ body: `${open.body || ""}\n\n![${file.name}](${path})\n` });
              }, "Added: describe it in the text, then save.");
            }} />
          </label>
        </p>
        <p>
          <label>Cover{" "}
            <input type="file" accept="image/*" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void run(async () => change({ cover: (await dash.addFile(open.lineageId, file)).path }), "Cover chosen; save to keep it.");
            }} />
          </label>{" "}
          {open.cover && <input value={open.coverDescription || ""} placeholder="what the cover shows" onChange={(event) => change({ coverDescription: event.target.value })} />}
        </p>
        <p>
          <button onClick={() => void run(async () => setOpen({ ...(await dash.save(open.lineageId, { ...open, expectedLastObservedAt: open.lastObservedAt })), body: open.body }), "Saved.")}>save</button>{" "}
          <button onClick={() => void run(async () => { await dash.remove(open.lineageId); setOpen(null); await refresh(); }, "Deleted.")}>delete</button>
        </p>
      </section>
    );
  }

  return (
    <>
      <h1>Entries</h1>
      <p className="muted">{said}</p>
      <p><button onClick={() => void run(async () => setOpen(await dash.entry((await dash.create({ title: "Untitled" })).lineageId)), "")}>new entry</button></p>
      <ul className="list">
        {entries.map((entry) => (
          <li key={entry.lineageId}>
            <button onClick={() => void run(async () => setOpen(await dash.entry(entry.lineageId)), "")}>{entry.title}</button>{" "}
            <span className="muted">{entry.type || ""} · {entry.status === "published" ? "public" : "private"}</span>
          </li>
        ))}
      </ul>
      {site && (
        <>
          <h2>Site</h2>
          <p><label>Contact email <input value={site.contactEmail} onChange={(event) => setSite({ ...site, contactEmail: event.target.value })} /></label></p>
          <p><label>Contact line <input value={site.contactLine} placeholder="Write to {email}." onChange={(event) => setSite({ ...site, contactLine: event.target.value })} /></label></p>
          <p><label>Tabs (one folder per line)<br /><textarea value={site.tabs} onChange={(event) => setSite({ ...site, tabs: event.target.value })} /></label></p>
          <p><button onClick={() => void run(async () => setSite(await dash.saveSite(site)), "Site saved.")}>save site</button></p>
          <h2>Key to private entries</h2>
          <p><label>Question <input value={key.question} onChange={(event) => setKey({ ...key, question: event.target.value })} /></label></p>
          <p><label>Answer <input value={key.answer} onChange={(event) => setKey({ ...key, answer: event.target.value })} /></label></p>
          <p><button onClick={() => void run(async () => { const saved = await dash.saveKey(key); setKey({ question: saved.question, answer: "" }); }, "Key saved.")}>save key</button></p>
        </>
      )}
    </>
  );
}
