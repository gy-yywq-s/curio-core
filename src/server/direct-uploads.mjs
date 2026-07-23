import { randomUUID } from "node:crypto";
import { bucketName, storageRequest } from "./supabase-store.mjs";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 256;
const ticketPath = id => `/curio/uploads/${id}.json`;
function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }
function validateName(name) {
  if (typeof name !== "string" || name.length > 512 || name.startsWith("/") || name.split(/[\\/]/).some(p => !p || p === "." || p === "..") || name.includes("\0")) throw invalid("Invalid upload filename.");
  return name.replaceAll("\\", "/");
}
export async function prepareUploads(files, descriptors) {
  if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > MAX_FILES) throw invalid("Choose between 1 and 256 files.");
  const total = descriptors.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(total) || total > MAX_BYTES) throw invalid("Upload at most 64 MB at a time.");
  const checked = descriptors.map(file => {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES) throw invalid("Invalid upload size.");
    return { name: validateName(file.name), size: file.size };
  });
  const result = [];
  // Bound concurrent signing calls while keeping folder uploads responsive.
  for (let offset = 0; offset < checked.length; offset += 8) {
    result.push(...await Promise.all(checked.slice(offset, offset + 8).map(async file => {
      const id = randomUUID();
      const objectKey = `uploads/${id}`;
      const response = await storageRequest(`object/upload/sign/${bucketName()}/${objectKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ upsert: false }),
      });
      const { url } = await response.json();
      if (typeof url !== "string") throw new Error("Storage did not return an upload URL.");
      const signedUrl = new URL(`${process.env.SUPABASE_URL}/storage/v1${url}`);
      const base = new URL(process.env.SUPABASE_URL);
      if (signedUrl.origin !== base.origin) throw new Error("Invalid Storage upload origin.");
      await files.writeFile(ticketPath(id), JSON.stringify({ ...file, objectKey, createdAt: Date.now() }), "utf8");
      return { id, url: signedUrl.href };
    })));
  }
  return result;
}
export async function consumeUploads(files, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_FILES || new Set(ids).size !== ids.length) throw invalid("Invalid uploaded files.");
  const uploaded = [];
  let total = 0;
  for (const id of ids) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw invalid("Invalid upload reference.");
    let ticket;
    try { ticket = JSON.parse(await files.readFile(ticketPath(id), "utf8")); }
    catch (error) { if (error.code === "ENOENT") throw invalid("The upload has expired. Please choose the files again."); throw error; }
    if (Date.now() - ticket.createdAt > 2 * 60 * 60 * 1000) throw invalid("The upload has expired. Please choose the files again.");
    const response = await storageRequest(`object/${bucketName()}/${ticket.objectKey}`);
    // Never trust a client-supplied size: enforce limits while reading the object.
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; total += chunk.length;
      if (size > ticket.size || total > MAX_BYTES) throw invalid("The uploaded files exceed their declared size.");
      chunks.push(chunk);
    }
    if (size !== ticket.size) throw invalid("An upload is incomplete. Please upload it again.");
    const bytes = Buffer.concat(chunks);
    files.preuploaded ||= new WeakMap();
    files.preuploaded.set(bytes, ticket.objectKey);
    uploaded.push({ name: validateName(ticket.name), bytes });
    await files.rm(ticketPath(id));
  }
  return uploaded;
}
