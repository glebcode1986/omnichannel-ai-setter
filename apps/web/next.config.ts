import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `next dev` would otherwise write apps/web/AGENTS.md + CLAUDE.md; agent rules for this
  // repository live in the root AGENTS.md/CLAUDE.md and must not be shadowed by generated files.
  agentRules: false,
  // Workspace packages export TypeScript source; Next compiles them as part of the app.
  transpilePackages: ["@omnichannel/env", "@omnichannel/observability"],
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
