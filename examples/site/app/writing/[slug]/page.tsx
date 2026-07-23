import Link from "next/link";
import { notFound } from "next/navigation";
import { folderHref, pathOf, tagsOf } from "curio-core";
import { resolveAsset } from "curio-core/read";
import { EntryBody } from "curio-core/react";
import { getReader } from "../../data";

/** One entry: its cover, title, date, folder, tags, body, and the entries that link to it. */
export default async function EntryPage({ params }: { params: Promise<{ slug: string }> }) {
  const reader = await getReader();
  const { slug } = await params;
  const entry = await reader.entry(slug);
  if (!entry) notFound();
  const mentions = await reader.mentions(entry.slug);
  const folder = pathOf(entry.folder);
  return (
    <article>
      {entry.cover && (
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={resolveAsset(entry, entry.cover)} alt={entry.coverDescription || ""} />
          {entry.coverDescription && <figcaption className="muted">{entry.coverDescription}</figcaption>}
        </figure>
      )}
      <h1>{entry.title}</h1>
      <p className="meta">
        {entry.date}
        {folder.length > 0 && <> · <Link href={folderHref(folder)}>{folder.join(" / ")}</Link></>}
        {tagsOf(entry).map((tag) => <span key={tag}> <Link href={`/everything?tag=${encodeURIComponent(tag)}`}>#{tag}</Link></span>)}
        {entry.showEdited && ` · edited ${entry.editedDate}`}
        {entry.private && " · private"}
      </p>
      <EntryBody entry={entry} />
      {mentions.length > 0 && (
        <section>
          <h2 className="muted">mentioned in</h2>
          <ul>{mentions.map((other) => <li key={other.id}><Link href={`/writing/${other.slug}`}>{other.title}</Link></li>)}</ul>
        </section>
      )}
    </article>
  );
}
