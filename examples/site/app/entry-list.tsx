import Link from "next/link";
import { pathOf, tagsOf } from "curio-core";
import type { Entry } from "curio-core/read";
import { EntryBody } from "curio-core/react";

/** Entries as a plain list: title, date, folder, tags, excerpt. */
export function EntryList({ entries }: { entries: Entry[] }) {
  if (entries.length === 0) return <p className="muted">Nothing here yet.</p>;
  return (
    <ul className="list">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link href={`/writing/${entry.slug}`}>{entry.title}</Link>
          <div className="meta">
            {entry.date}
            {pathOf(entry.folder).length > 0 && ` · ${pathOf(entry.folder).join(" / ")}`}
            {tagsOf(entry).map((tag) => ` #${tag}`)}
            {entry.private && " · private"}
          </div>
          {entry.excerpt && <EntryBody entry={{ ...entry, body: entry.excerpt }} />}
        </li>
      ))}
    </ul>
  );
}
