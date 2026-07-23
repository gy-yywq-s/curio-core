import { EntryBody } from "curio-core/react";
import { getReader } from "../data";

/** The about page: the entry whose folder is "about". */
export default async function About() {
  const entry = await (await getReader()).about();
  return entry ? <EntryBody entry={entry} /> : <p className="muted">Nothing written here yet.</p>;
}
