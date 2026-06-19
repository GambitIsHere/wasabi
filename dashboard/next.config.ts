import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep node:sqlite (and its native binding) external to the server bundle so
  // Turbopack/webpack don't try to trace or bundle the built-in module.
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
