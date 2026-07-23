"use client";

import { useActionState } from "react";
import { answer } from "./actions";

export function KeyForm({ question }: { question: string }) {
  const [result, give, pending] = useActionState(answer, "");
  return (
    <form action={give}>
      <label htmlFor="answer">{question}</label>
      <p><input id="answer" name="answer" autoComplete="off" required autoFocus /> <button disabled={pending}>→</button></p>
      <p className="muted" aria-live="polite">{result === "wrong" ? "not that" : result === "wait" ? "later" : ""}</p>
    </form>
  );
}
