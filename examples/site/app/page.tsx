import { EntryList } from "./entry-list";
import { getReader } from "./data";

/** Home: every entry, newest first. */
export default async function Home() {
  const reader = await getReader();
  return <EntryList entries={await reader.listed()} />;
}
