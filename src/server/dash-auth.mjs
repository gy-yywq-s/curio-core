import { createRemoteJWKSet, jwtVerify } from "jose";
let jwks;
export async function canAccessDashboard(headers) {
  // This mode is valid ONLY behind project-wide Vercel Authentication.
  // No production fallback: production still requires Cloudflare Access.
  if (process.env.VERCEL_ENV === "preview" && process.env.CURIO_DASH_AUTH === "vercel-preview") return true;
  const host = (headers.get("host") || "").split(":")[0];
  // A production site not yet public: valid ONLY while Vercel Authentication
  // covers every deployment, production included, and only on its
  // *.vercel.app addresses. Remove CURIO_DASH_AUTH from Production before
  // the site is made public; a custom domain always needs Cloudflare Access.
  if (process.env.VERCEL_ENV === "production" && process.env.CURIO_DASH_AUTH === "vercel-protected" && host.endsWith(".vercel.app")) return true;
  if (!process.env.VERCEL && process.env.DASH_AUTH_BYPASS === "true" && ["localhost", "127.0.0.1"].includes(host)) return true;
  const domain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  const audience = process.env.CLOUDFLARE_ACCESS_AUD;
  const assertion = headers.get("cf-access-jwt-assertion");
  if (!domain || !audience || !assertion) return false;
  const issuer = (/^https:\/\//.test(domain) ? domain : `https://${domain}`).replace(/\/$/, "");
  try {
    jwks ||= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    await jwtVerify(assertion, jwks, { issuer, audience, algorithms: ["RS256"] });
    return true;
  } catch { return false; }
}
