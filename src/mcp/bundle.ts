import path from "node:path";

/**
 * Where `npm run build` leaves the frozen copy of the HQ MCP server, relative
 * to the repository root (ignored by Git): `server.mjs` is the bundle of
 * `src/mcp/server.ts`, `templates/roles` a copy of the role templates it reads.
 * Shared by the build script and by the runner so that they cannot disagree.
 */
export const MCP_BUNDLE_DIR = ["build", "mcp"] as const;

export function mcpBundleDir(repoRoot: string): string {
  return path.join(repoRoot, ...MCP_BUNDLE_DIR);
}

export function mcpBundleEntry(repoRoot: string): string {
  return path.join(mcpBundleDir(repoRoot), "server.mjs");
}
