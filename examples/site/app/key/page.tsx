import { notFound } from "next/navigation";
import { keyQuestion } from "curio-core/next/reader";
import { KeyForm } from "./form";

/** The key to private entries: the owner's question and a line for the answer. No key set: no page. */
export default async function Key() {
  const question = await keyQuestion();
  if (!question) notFound();
  return <KeyForm question={question} />;
}
