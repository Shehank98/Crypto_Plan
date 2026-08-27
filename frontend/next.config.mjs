/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Proxy API calls to the Express server. In the combined single-service
  // container the API runs on 127.0.0.1:4000; override with API_INTERNAL_URL.
  // In local dev this forwards :3000/api -> :4000/api too.
  async rewrites() {
    const target = process.env.API_INTERNAL_URL || "http://127.0.0.1:4000";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  },
};

export default nextConfig;
