import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // CLAUDE.md already points agents to node_modules/next/dist/docs/.
  agentRules: false,
  // The assistant imports the home's TypeScript extensions at runtime with
  // tsx (esbuild underneath), which must not be bundled.
  serverExternalPackages: ["tsx"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
