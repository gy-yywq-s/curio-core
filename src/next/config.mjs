/**
 * The Next.js settings curio needs, around your own:
 *   /dash/api/*  -> pages/api/dash/[...path]  (dashHandler)
 *   /media/*     -> pages/api/media/[...path] (mediaHandler)
 * and the package compiled with your app. Plain JavaScript, so a
 * next.config can import it.
 */
/**
 * @param {import("next").NextConfig} [config]
 * @returns {import("next").NextConfig}
 */
export function withCurio(config = {}) {
  const rewrites = config.rewrites;
  return {
    ...config,
    transpilePackages: [...(config.transpilePackages || []), "curio-core"],
    serverExternalPackages: [...(config.serverExternalPackages || []), "postgres"],
    async rewrites() {
      const own = rewrites ? await rewrites() : [];
      const ours = [
        { source: "/dash/api/:path*", destination: "/api/dash/:path*" },
        { source: "/media/:path*", destination: "/api/media/:path*" },
      ];
      if (Array.isArray(own)) return [...ours, ...own];
      return { ...own, beforeFiles: [...ours, ...(own.beforeFiles || [])] };
    },
  };
}
