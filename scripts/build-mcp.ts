/**
 * `npm run build` (after `next build`): freezes the HQ MCP server.
 *
 * Every agent run starts this server. Started from the sources of the working
 * directory, it would run whatever an agent (or the developer) has in that
 * folder at that moment, uncommitted code included, against the database in
 * service. So the build bundles `src/mcp/server.ts` (and the app modules it
 * imports) into `build/mcp/server.mjs`, with a copy of the role templates it
 * reads, and the runner starts that copy. Dependencies stay external: they
 * are resolved from `node_modules`, and `better-sqlite3` is a native module
 * that cannot be bundled anyway.
 *
 * The new copy is built beside the old one and swapped in, so a run starting
 * during the build finds either the old or the new copy, never half of one.
 */
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { mcpBundleDir } from "../src/mcp/bundle";

/** Builds the frozen server of the repository at `repoRoot` into `<repoRoot>/build/mcp`. Returns its folder. */
export async function buildMcpBundle(repoRoot: string): Promise<string> {
  const outDir = mcpBundleDir(repoRoot);
  const stagingDir = `${outDir}.tmp`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    await build({
      entryPoints: [path.join(repoRoot, "src", "mcp", "server.ts")],
      outfile: path.join(stagingDir, "server.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      packages: "external",
      logLevel: "warning",
    });
    fs.cpSync(path.join(repoRoot, "templates", "roles"), path.join(stagingDir, "templates", "roles"), {
      recursive: true,
    });
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, outDir);
  } catch (error) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
  return outDir;
}

if (require.main === module) {
  buildMcpBundle(process.cwd())
    .then((dir) => console.log(`[build-mcp] frozen HQ MCP server: ${path.relative(process.cwd(), dir)}`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
