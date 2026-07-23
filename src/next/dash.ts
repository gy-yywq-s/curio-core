import type { NextApiRequest, NextApiResponse } from "next";
import { canAccessDashboard } from "../server/dash-auth.mjs";
import { createDashboardApi } from "../server/dashboard-api.mjs";
import { consumeUploads, prepareUploads } from "../server/direct-uploads.mjs";
import { filesSourceEnabled } from "../server/files-source.mjs";
import { remoteStorageEnabled, withStore } from "../server/store.mjs";

type Seed = () => Promise<Array<{ filename: string; source: string }> | null | undefined>;

/** The request's headers as a Headers object. */
export function headersOf(request: NextApiRequest) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
  return headers;
}

/**
 * The dashboard's API, as a Pages Router API route. Put it at
 * pages/api/dash/[...path].ts:
 *
 *   export { dashConfig as config } from "curio-core/next/dash";
 *   export default dashHandler();
 *
 * withCurio (next config) serves it at /dash/api/*. Every request must pass
 * canAccessDashboard (or `authorize`, when given); each one runs in one
 * transaction and is rolled back if it fails.
 */
export const dashConfig = { api: { bodyParser: false, responseLimit: "8mb" }, maxDuration: 60 };

export function dashHandler({ authorize = canAccessDashboard, seed }: { authorize?: (headers: Headers) => Promise<boolean>; seed?: Seed } = {}) {
  return async function handler(request: NextApiRequest, response: NextApiResponse) {
    request.url = request.url?.replace(/^\/api\/dash(?=\/|$)/, "/dash/api");
    response.setHeader("Cache-Control", "no-store");
    if (filesSourceEnabled()) return response.status(404).json({ error: "This site is read from files; it has no dashboard." });
    const headers = headersOf(request);
    if (!(await authorize(headers))) return response.status(401).json({ error: "Dashboard access requires authentication." });
    if (!["GET", "HEAD"].includes(request.method || "GET")) {
      const origin = headers.get("origin");
      if (origin && new URL(origin).host !== (headers.get("x-forwarded-host") || headers.get("host"))) {
        return response.status(403).json({ error: "Cross-origin changes are not allowed." });
      }
    }
    let status = 200;
    let body = "";
    const captured = {
      headersSent: false,
      writableEnded: false,
      writeHead(code: number) { status = code; },
      end(value = "") { body = value; },
    };
    const rollback = new Error("Rollback response");
    try {
      await withStore(async (store, files) => {
        const options = remoteStorageEnabled()
          ? {
              resolveUploads: (ids: string[]) => consumeUploads(files, ids),
              signUploads: (descriptors: { name: string; size: number }[]) => prepareUploads(files, descriptors),
              seed,
            }
          : { seed };
        const handled = await createDashboardApi(store, options)(request, captured);
        if (!handled) { status = 404; body = JSON.stringify({ error: "Not found." }); }
        if (status >= 400) throw rollback;
      }, { write: true });
    } catch (error) {
      if (error !== rollback) {
        console.error("[dash] request failed", error instanceof Error ? error.message : "UnknownError");
        status = 503;
        body = JSON.stringify({ error: "Storage is temporarily unavailable. Please retry." });
      }
    }
    response.status(status).setHeader("Content-Type", "application/json");
    response.end(body);
  };
}

/** For the dashboard page itself (a server component): whether to show it. */
export async function canOpenDash(authorize: (headers: Headers) => Promise<boolean> = canAccessDashboard) {
  const { headers } = await import("next/headers");
  return authorize(await headers());
}
