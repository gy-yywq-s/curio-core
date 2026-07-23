import { cookies } from "next/headers";
import { cache } from "react";
import { createReader, type ReaderOptions } from "../read";
import { keyCookie, keyDays, readKey, tokenFor, tokenOpens, tryAnswer } from "../server/private-key.mjs";
import { filesSourceEnabled } from "../server/files-source.mjs";
import { withStore } from "../server/store.mjs";

let defaults: Omit<ReaderOptions, "includePrivate"> = {};

/** How every reader writes dates and entry addresses (call once, e.g. in your layout module). */
export function configureReader(options: Omit<ReaderOptions, "includePrivate">) {
  defaults = options;
}

/** Whether this browser holds the key to private entries. */
export const keyHolder = cache(async function keyHolder(): Promise<boolean> {
  if (filesSourceEnabled()) return false;
  const token = (await cookies()).get(keyCookie)?.value;
  if (!token) return false;
  try {
    return tokenOpens(await withStore((store) => readKey(store)), token);
  } catch {
    return false;
  }
});

/**
 * The reader for this request (see createReader), with private entries
 * when the browser holds the key. Pages that call it are dynamic.
 */
export const getReader = cache(async function getReader() {
  return createReader({ ...defaults, includePrivate: await keyHolder() });
});

/** The key's question, or null when no key is set (then /key should not exist). */
export async function keyQuestion(): Promise<string | null> {
  if (filesSourceEnabled()) return null;
  return (await withStore((store) => readKey(store)))?.question ?? null;
}

/**
 * Checks an answer to the key's question; call it from a server action.
 * "open": the browser now holds the key (a cookie for 90 days).
 * "wrong", "wait" (too many wrong answers lately), "none" (no key is set).
 */
export async function answerKey(answer: string): Promise<"open" | "wrong" | "wait" | "none"> {
  const outcome = await withStore(async (store) => {
    const result = await tryAnswer(store, String(answer ?? "").slice(0, 200));
    return { result, token: result === "open" ? tokenFor(await readKey(store)) : "" };
  }, { write: true });
  if (outcome.result === "open") {
    (await cookies()).set(keyCookie, outcome.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: keyDays * 24 * 60 * 60,
    });
  }
  return outcome.result as "open" | "wrong" | "wait" | "none";
}

/** Puts the key away in this browser; call it from a server action. */
export async function hideKey() {
  (await cookies()).delete(keyCookie);
}
