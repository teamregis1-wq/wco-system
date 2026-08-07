/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: ["recharts", "react-leaflet"],
  },
};
export default nextConfig;
