import Link from "next/link";
import { flatten, folderHref } from "curio-core";
import { EntryList } from "../entry-list";
import { getReader } from "../data";

/** The whole index: search and tags, or the folder tree. */
export default async function Everything({ searchParams }: { searchParams: Promise<{ q?: string; tag?: string | string[] }> }) {
  const reader = await getReader();
  const query = await searchParams;
  const tags = [query.tag || []].flat();
  const [tree, allTags] = await Promise.all([reader.tree(), reader.tags()]);
  const narrowing = Boolean(query.q) || tags.length > 0;
  return (
    <>
      <form>
        <input name="q" defaultValue={query.q} placeholder="search" />
        {tags.map((tag) => <input key={tag} type="hidden" name="tag" value={tag} />)}
      </form>
      <p className="meta">
        {allTags.map((tag) => <Link key={tag.name} href={`/everything?tag=${encodeURIComponent(tag.name)}`}>#{tag.name} </Link>)}
      </p>
      {narrowing ? (
        <EntryList entries={await reader.search(query.q || "", tags)} />
      ) : (
        <ul>
          {flatten(tree).slice(1).map(({ node, depth }) => (
            <li key={node.key} style={{ marginLeft: `${depth - 1}rem` }}>
              <Link href={folderHref(node.path)}>{node.name}</Link> <span className="muted">{node.entries.length}</span>
            </li>
          ))}
          {tree.entries.length > 0 && <li><span className="muted">not in a folder: {tree.entries.length}</span></li>}
        </ul>
      )}
    </>
  );
}
