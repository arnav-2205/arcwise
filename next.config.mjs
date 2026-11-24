/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server code (Express + engine) is not bundled by Next; the UI only talks to it over /api.
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
