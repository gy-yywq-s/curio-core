import test from "node:test";
import assert from "node:assert/strict";
import { canAccessDashboard } from "../src/server/dash-auth.mjs";

test("preview auth is explicit, production fails closed, and local bypass requires loopback", async () => {
  const names = ["VERCEL", "VERCEL_ENV", "CURIO_DASH_AUTH", "DASH_AUTH_BYPASS", "CLOUDFLARE_ACCESS_AUD", "CLOUDFLARE_ACCESS_TEAM_DOMAIN"];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    names.forEach(name => delete process.env[name]);
    const headers = new Headers({ host: "example.com" });
    assert.equal(await canAccessDashboard(headers), false);
    process.env.VERCEL = "1"; process.env.VERCEL_ENV = "preview";
    assert.equal(await canAccessDashboard(headers), false);
    process.env.CURIO_DASH_AUTH = "vercel-preview";
    assert.equal(await canAccessDashboard(headers), true);
    process.env.VERCEL_ENV = "production";
    assert.equal(await canAccessDashboard(headers), false);
    // A protected production site before it is public: only on its vercel.app address.
    process.env.CURIO_DASH_AUTH = "vercel-protected";
    assert.equal(await canAccessDashboard(new Headers({ host: "curiog.vercel.app" })), true);
    assert.equal(await canAccessDashboard(headers), false);
    process.env.VERCEL_ENV = "preview";
    assert.equal(await canAccessDashboard(new Headers({ host: "curiog.vercel.app" })), false);
    process.env.VERCEL_ENV = "production";
    delete process.env.VERCEL; delete process.env.VERCEL_ENV;
    process.env.DASH_AUTH_BYPASS = "true";
    assert.equal(await canAccessDashboard(headers), false);
    assert.equal(await canAccessDashboard(new Headers({ host: "127.0.0.1:3200" })), true);
  } finally {
    for (const name of names) if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name];
  }
});
