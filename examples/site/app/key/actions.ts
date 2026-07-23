"use server";

import { redirect } from "next/navigation";
import { answerKey, hideKey } from "curio-core/next/reader";

export async function answer(_state: string, form: FormData) {
  const result = await answerKey(String(form.get("answer") ?? ""));
  if (result === "open" || result === "none") redirect("/");
  return result;
}

export async function hide() {
  await hideKey();
  redirect("/");
}
