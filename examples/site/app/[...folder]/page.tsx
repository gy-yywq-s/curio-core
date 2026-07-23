import Link from "next/link";
import { notFound } from "next/navigation";
import { countIn, folderHref } from "curio-core";
import type { Entry } from "curio-core/read";
import { EntryList } from "../entry-list";
import { getReader } from "../data";

/** A folder: the folders inside it, then its own entries. */
export default async function FolderPage({ params }: { params: Promise<{ folder: string[] }> }) {
  const reader = await getReader();
  const folder = await reader.folder((await params).folder);
  if (!folder) notFound();
  return (
    <>
      <h1>{folder.name}</h1>
      {folder.children.length > 0 && (
        <ul>
          {folder.children.map((child) => (
            <li key={child.key}><Link href={folderHref(child.path)}>{child.name}</Link> <span className="muted">{countIn(child)}</span></li>
          ))}
        </ul>
      )}
      <EntryList entries={folder.entries as Entry[]} />
    </>
  );
}
