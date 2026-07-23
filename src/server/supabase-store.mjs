import postgres from "postgres";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ContentStore } from "./content-store.mjs";

// Keep the existing Markdown/document format, with transactional database writes.
// Binary objects are immutable; rolling back SQL cannot damage an older revision.
const root = "/curio";
let pool;
let ready;
export function storageNamespace() {
  const value = process.env.CURIO_STORAGE_NAMESPACE;
  if (!value || !/^[a-z][a-z0-9_]{0,40}$/.test(value)) {
    throw new Error("CURIO_STORAGE_NAMESPACE must explicitly name this environment.");
  }
  return value;
}
export function remoteStorageEnabled() {
  return Boolean(process.env.POSTGRES_URL);
}
function database() {
  pool ||= postgres(process.env.POSTGRES_URL, {
    max: 2, prepare: false, idle_timeout: 20, connect_timeout: 15,
    ssl: "require",
  });
  return pool;
}
function missing() { return Object.assign(new Error("Content not found."), { code: "ENOENT" }); }
function keyOf(filename) {
  const key = path.posix.relative(root, filename);
  if (key.startsWith("../") || path.isAbsolute(key)) throw new Error("Invalid content path.");
  return key;
}
export async function storageRequest(endpoint, options = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!base || !key) throw new Error("Supabase Storage is not configured.");
  const response = await fetch(`${base}/storage/v1/${endpoint}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...options.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`Storage request failed (${response.status}).`);
  return response;
}
export function bucketName() { return `curio-${storageNamespace().replaceAll("_", "-")}`; }
async function initializeDatabase() {
  if (!ready) ready = (async () => {
    const sql = database();
    const poolerRegion = new URL(process.env.POSTGRES_URL).hostname.match(/aws-\d+-([^.]+)\.pooler\.supabase\.com/)?.[1];
    console.info("[storage] database region", poolerRegion || "direct connection");
    console.info("[storage] runtime region", process.env.VERCEL_REGION || "local");
    // A private schema is deliberately outside Supabase's public Data API.
    await sql`create schema if not exists curio_private`;
    await sql`create table if not exists curio_private.documents (
      namespace text not null, path text not null, body bytea, object_key text,
      modified_at timestamptz not null default now(),
      primary key(namespace, path),
      check ((body is null) <> (object_key is null))
    )`;
    const bucket = bucketName();
    await sql`insert into storage.buckets(id, name, public, file_size_limit)
      values (${bucket}, ${bucket}, false, 67108864) on conflict (id) do nothing`;
  })().catch(error => { ready = undefined; throw error; });
  return ready;
}
export class DatabaseFiles {
  constructor(sql, namespace, objects = null) {
    this.sql = sql;
    this.namespace = namespace;
    // This adapter belongs to one transaction; never reuse it after commit/rollback.
    this.cache = new Map();
    this.objects = objects || {
      async put(bytes) {
        const objectKey = `objects/${randomUUID()}`;
        await storageRequest(`object/${bucketName()}/${objectKey}`, {
          method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes,
        });
        return objectKey;
      },
      async get(key) { return Buffer.from(await (await storageRequest(`object/${bucketName()}/${key}`)).arrayBuffer()); },
    };
  }
  async mkdir() { /* Directories are implicit in document paths. */ }
  async row(filename) {
    const key = keyOf(filename);
    if (this.cache.has(key)) return this.cache.get(key);
    const rows = await this.sql`select body, object_key, modified_at from curio_private.documents
      where namespace = ${this.namespace} and path = ${keyOf(filename)}`;
    if (!rows.length) throw missing();
    this.cache.set(key, rows[0]);
    return rows[0];
  }
  async readFile(filename, encoding) {
    const row = await this.row(filename);
    const bytes = row.object_key ? await this.objects.get(row.object_key) : Buffer.from(row.body);
    return encoding ? bytes.toString(encoding) : bytes;
  }
  /**
   * A short-lived signed address for a file kept in Storage (six hours),
   * or null for one kept in the database. The media route hands videos
   * over this way, so they stream and seek straight from Storage.
   */
  async objectUrl(filename) {
    const row = await this.row(filename);
    if (!row.object_key) return null;
    const response = await storageRequest(`object/sign/${bucketName()}/${row.object_key}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 6 * 60 * 60 }),
    });
    const { signedURL } = await response.json();
    if (typeof signedURL !== "string") throw new Error("Storage did not sign the file.");
    const address = new URL(`${process.env.SUPABASE_URL}/storage/v1${signedURL}`);
    if (address.origin !== new URL(process.env.SUPABASE_URL).origin) throw new Error("Invalid Storage address.");
    return address.href;
  }
  async writeFile(filename, value, encoding) {
    const key = keyOf(filename);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
    const binary = key.startsWith("media/") || (key.startsWith("staging/") && !/\.(md|json)(\.|$)/i.test(key));
    const objectKey = binary ? this.preuploaded?.get(bytes) || await this.objects.put(bytes) : null;
    await this.sql`insert into curio_private.documents(namespace, path, body, object_key)
      values (${this.namespace}, ${key}, ${binary ? null : bytes}, ${objectKey})
      on conflict(namespace, path) do update set body = excluded.body,
      object_key = excluded.object_key, modified_at = now()`;
    this.cache.set(key, { body: binary ? null : bytes, object_key: objectKey, modified_at: new Date() });
  }
  async atomicJson(filename, value) {
    return this.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  async appendFile(filename, value) {
    await this.sql`insert into curio_private.documents(namespace, path, body)
      values (${this.namespace}, ${keyOf(filename)}, ${Buffer.from(value)})
      on conflict(namespace, path) do update set body = curio_private.documents.body || excluded.body,
      modified_at = now()`;
    this.cache.delete(keyOf(filename));
  }
  async copyFile(source, destination) {
    const row = await this.row(source);
    await this.sql`insert into curio_private.documents(namespace, path, body, object_key)
      values (${this.namespace}, ${keyOf(destination)}, ${row.body}, ${row.object_key})
      on conflict(namespace, path) do update set body = excluded.body,
      object_key = excluded.object_key, modified_at = now()`;
    this.cache.set(keyOf(destination), row);
  }
  async rename(source, destination) {
    await this.copyFile(source, destination);
    await this.rm(source);
  }
  async readdir(directory) {
    const prefix = `${keyOf(directory)}/`;
    const rows = await this.sql`select path, body, object_key, modified_at from curio_private.documents
      where namespace = ${this.namespace} and starts_with(path, ${prefix})`;
    for (const row of rows) this.cache.set(row.path, row);
    return [...new Set(rows.map(row => row.path.slice(prefix.length).split("/")[0]))];
  }
  async stat(filename) {
    const key = keyOf(filename);
    const rows = await this.sql`select modified_at, octet_length(body) as size
      from curio_private.documents where namespace = ${this.namespace}
      and (path = ${key} or starts_with(path, ${key + "/"})) limit 1`;
    if (!rows.length) throw missing();
    return { mtimeMs: new Date(rows[0].modified_at).valueOf(), size: rows[0].size, isFile: () => true };
  }
  async rm(filename, options = {}) {
    const key = keyOf(filename);
    await this.sql`delete from curio_private.documents where namespace = ${this.namespace}
      and (path = ${key} or (${Boolean(options.recursive)} and starts_with(path, ${key + "/"})))`;
    for (const cached of this.cache.keys()) {
      if (cached === key || (options.recursive && cached.startsWith(key + "/"))) this.cache.delete(cached);
    }
    // Objects are retained for rollback/history. Explicit maintenance can collect unreferenced objects.
  }
}
export async function withRemoteStore(operation, { write = false } = {}) {
  await initializeDatabase();
  const namespace = storageNamespace();
  return database().begin(write ? "" : "isolation level repeatable read read only", async sql => {
    if (write) {
      // Cross-instance serialization; a failed import rolls back all its metadata and revisions.
      await sql`select pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`;
    }
    const files = new DatabaseFiles(sql, namespace);
    const store = new ContentStore(root, files);
    // Cleanup is a write and is performed on dashboard operations only.
    store.initialize = async () => {};
    return operation(store, files);
  });
}
