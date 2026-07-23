import type { NextApiRequest, NextApiResponse } from "next";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canAccessDashboard } from "../server/dash-auth.mjs";
import { contentDirectory, filesSourceEnabled } from "../server/files-source.mjs";
import { keyCookie, readKey, tokenOpens } from "../server/private-key.mjs";
import { withStore } from "../server/store.mjs";
import { headersOf } from "./dash";

const types: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".svg": "image/svg+xml", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};

/** What part of `size` bytes a Range header asks for: null for all of it, undefined when it cannot be met. */
function rangeOf(header: string | undefined, size: number): [number, number] | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!match || (!match[1] && !match[2])) return null;
  const start = Math.max(0, match[1] ? Number(match[1]) : size - Number(match[2]));
  const end = Math.min(match[1] && match[2] ? Number(match[2]) : size - 1, size - 1);
  return start <= end ? [start, end] : undefined;
}

/**
 * Files beside entries (pictures, videos), as a Pages Router API route at
 * pages/api/media/[...path].ts (withCurio serves it at /media/*):
 *
 *   export default mediaHandler();
 *
 * For whoever may see the entry: everyone for a public one; the owner or a
 * browser holding the key for any. From Supabase Storage a video is handed
 * over as a signed address, so it streams without passing through here;
 * everything served here answers byte ranges. With a Git folder as the
 * source, /media/files/<path> is a file in that folder (never an entry's
 * own .md/.html, nor anything under a _ or . name).
 */
export function mediaHandler({ authorize = canAccessDashboard }: { authorize?: (headers: Headers) => Promise<boolean> } = {}) {
  return async function handler(request: NextApiRequest, response: NextApiResponse) {
    if (!["GET", "HEAD"].includes(request.method || "")) return response.status(405).end();
    const segments = request.query.path;
    if (!Array.isArray(segments) || segments.some((piece) => !piece || piece === "." || piece === ".." || /[/\\\0]/.test(piece))) {
      return response.status(400).end();
    }
    const type = types[path.extname(segments.at(-1)!).toLowerCase()] || "application/octet-stream";
    try {
      let found: { address: string | null; bytes: Buffer | null } | null;
      let shut = true;
      if (filesSourceEnabled()) {
        const hidden = segments[0] !== "files" || segments.some((piece) => /^[_.]/.test(piece)) || /\.(?:md|html?|json)$/i.test(segments.at(-1)!);
        found = hidden ? null : { address: null, bytes: await readFile(path.join(contentDirectory()!, ...segments.slice(1))) };
        shut = false;
      } else {
        const admin = await authorize(headersOf(request));
        found = await withStore(async (store, files) => {
          let filename;
          if (segments[0] === "staging") {
            if (!admin || segments.length < 3) return null;
            filename = path.join(store.stagingDirectory, ...segments.slice(1));
          } else {
            const record = segments[0] === "gallery" ? null : await store.getRecord(segments[0]);
            shut = segments[0] === "gallery"
              ? !(await store.listGallery({ includeDrafts: false })).some((item: { id: string }) => item.id === segments[1])
              : record?.status !== "published";
            if (shut && !admin && !tokenOpens(await readKey(store), request.cookies[keyCookie])) return null;
            filename = path.join(store.mediaDirectory, ...segments);
          }
          const signer = files as { objectUrl?: (filename: string) => Promise<string | null> };
          if (type.startsWith("video/") && typeof signer.objectUrl === "function") {
            const address = await signer.objectUrl(filename);
            if (address) return { address, bytes: null };
          }
          return { address: null, bytes: (await files.readFile(filename)) as Buffer };
        });
      }
      if (!found) return response.status(404).end();
      if (found.address) {
        response.setHeader("Cache-Control", "private, no-store");
        return response.redirect(302, found.address);
      }
      const bytes = found.bytes as Buffer;
      response.setHeader("Content-Type", type);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", shut ? "private, no-cache" : "public, max-age=300");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "sandbox");
      const range = rangeOf(request.headers.range, bytes.length);
      if (range === undefined) {
        response.setHeader("Content-Range", `bytes */${bytes.length}`);
        return response.status(416).end();
      }
      if (range) {
        response.setHeader("Content-Range", `bytes ${range[0]}-${range[1]}/${bytes.length}`);
        response.setHeader("Content-Length", String(range[1] - range[0] + 1));
        return response.status(206).end(request.method === "HEAD" ? undefined : bytes.subarray(range[0], range[1] + 1));
      }
      response.setHeader("Content-Length", String(bytes.length));
      response.status(200).end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.status(404).end();
    }
  };
}
