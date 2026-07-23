import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";

/**
 * The key to private entries on the public site: a question the owner
 * set and its answer. The answer is kept only as a salted hash; a right
 * answer gives the browser a signed cookie for `keyDays`, and every page
 * then shows private entries too. Changing the answer turns every cookie
 * given before it away. Wrong answers are counted: after `triesAllowed`
 * in `triesWindow`, no answer is taken until the window has passed.
 */
export const keyCookie = "curio_key";
export const keyDays = 90;
const triesAllowed = 6;
const triesWindow = 15 * 60 * 1000;

const keyFile = (store) => path.join(store.settingsDirectory, "private-key.json");
const triesFile = (store) => path.join(store.settingsDirectory, "private-key-tries.json");

/** Answers are compared without case, accents' composition or extra spaces. */
export function normalAnswer(answer) {
  return String(answer ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function hashOf(answer, salt) {
  return scryptSync(normalAnswer(answer), Buffer.from(salt, "base64"), 32).toString("base64");
}

async function readJson(store, filename) {
  try {
    return JSON.parse(await store.fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code && error.code !== "ENOENT") throw error;
    return null;
  }
}

/** The stored key, or null when none is set: { question, salt, hash }. */
export async function readKey(store) {
  const key = await readJson(store, keyFile(store));
  return key && typeof key.question === "string" && key.question && key.hash && key.salt ? key : null;
}

/** What the dashboard may see: the question, and whether an answer is set. */
export async function keySummary(store) {
  const key = await readJson(store, keyFile(store));
  return { question: typeof key?.question === "string" ? key.question : "", answerSet: Boolean(key?.hash) };
}

/**
 * Sets the question, the answer, or both. An empty answer keeps the old
 * one; an empty question removes the key (private entries stay private).
 */
export async function writeKey(store, { question, answer } = {}) {
  return store.serialize(async () => {
    await store.initialize();
    const existing = (await readJson(store, keyFile(store))) || {};
    const nextQuestion = String(question ?? existing.question ?? "").replace(/\s+/g, " ").trim();
    const nextAnswer = normalAnswer(answer);
    if (!nextQuestion) {
      await store.atomicJson(keyFile(store), {});
      return keySummary(store);
    }
    let { salt, hash } = existing;
    if (nextAnswer) {
      salt = randomBytes(16).toString("base64");
      hash = hashOf(nextAnswer, salt);
    }
    if (!hash) throw Object.assign(new Error("Give the answer too."), { statusCode: 400 });
    await store.atomicJson(keyFile(store), { question: nextQuestion, salt, hash });
    return keySummary(store);
  });
}

function signature(key, expires) {
  return createHmac("sha256", Buffer.from(`${key.salt}:${key.hash}`)).update(`private:${expires}`).digest("base64url");
}

function same(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A cookie value that opens private entries until it expires. */
export function tokenFor(key, now = Date.now()) {
  const expires = now + keyDays * 24 * 60 * 60 * 1000;
  return `${expires}.${signature(key, expires)}`;
}

export function tokenOpens(key, token, now = Date.now()) {
  if (!key || typeof token !== "string") return false;
  const [expires, mark] = token.split(".");
  const until = Number(expires);
  if (!Number.isFinite(until) || until < now || !mark) return false;
  return same(mark, signature(key, until));
}

/**
 * Checks an answer. Returns "open", "wrong", "wait" (too many wrong
 * answers lately) or "none" (no key is set).
 */
export async function tryAnswer(store, answer, now = Date.now()) {
  return store.serialize(async () => {
    const key = await readKey(store);
    if (!key) return "none";
    const recent = ((await readJson(store, triesFile(store)))?.wrong || []).filter((at) => typeof at === "number" && now - at < triesWindow);
    if (recent.length >= triesAllowed) return "wait";
    if (normalAnswer(answer) && same(hashOf(answer, key.salt), key.hash)) {
      if (recent.length) await store.atomicJson(triesFile(store), { wrong: [] });
      return "open";
    }
    await store.atomicJson(triesFile(store), { wrong: [...recent, now] });
    return "wrong";
  });
}
