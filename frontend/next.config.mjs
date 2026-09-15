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
};
export default nextConfig;
