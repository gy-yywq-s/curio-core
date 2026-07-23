import path from "node:path";
import { ContentStore } from "./content-store.mjs";
import { remoteStorageEnabled, withRemoteStore } from "./supabase-store.mjs";
let localStore;
export { remoteStorageEnabled };
/**
 * @template T
 * @param {(store: ContentStore, files: typeof import('node:fs/promises')) => Promise<T>} operation
 * @param {{write?: boolean}} [options]
 * @returns {Promise<T>}
 */
export async function withStore(operation, options) {
  if (remoteStorageEnabled()) return withRemoteStore(operation, options);
  if (process.env.VERCEL) throw new Error("Persistent storage is required on Vercel.");
  localStore ||= new ContentStore(path.resolve(/* turbopackIgnore: true */ process.env.CURIO_DATA_DIR || path.join(process.cwd(), ".curio-data")));
  await localStore.initialize();
  return operation(localStore, localStore.fs);
}
