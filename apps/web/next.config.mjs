/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The browser talks to the API directly via NEXT_PUBLIC_API_URL (see lib/api.ts).
  // No rewrites/proxies are configured on purpose: the API's CORS allowlist is the
  // control point, and a hidden proxy would obscure which origin is in use.
};

export default nextConfig;
