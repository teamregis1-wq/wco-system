/**
 * How the browser reaches the FastAPI backend (see docs/DEPLOYMENT.md):
 *  - NEXT_PUBLIC_API_BASE=https://<backend>/api/v1 → the browser calls the backend directly
 *    (the backend's CORS_ORIGINS must include this site's URL).
 *  - or leave it unset and set BACKEND_URL=https://<backend> → the browser calls same-origin
 *    /api/v1 and Next.js proxies it to the backend (no CORS needed).
 * Both are read at BUILD time; redeploy after changing them.
 */
const backendUrl = (process.env.BACKEND_URL || "").replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: ["recharts", "react-leaflet"],
  },
  // Sign-in lives in a popover on the landing page. Keep old /login links and
  // bookmarks working by sending them there with the popover already open.
  async redirects() {
    return [{ source: "/login", destination: "/?signin=1", permanent: false }];
  },
  async rewrites() {
    return backendUrl ? [{ source: "/api/:path*", destination: `${backendUrl}/api/:path*` }] : [];
  },
};
export default nextConfig;
