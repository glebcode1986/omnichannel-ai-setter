import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * The web app's test project.
 *
 * It exists for one reason: the `@/` alias. TypeScript resolves it from `tsconfig.json` and Next resolves
 * it when building, but Vitest has its own resolver and would otherwise fail to import any component that
 * uses it.
 *
 * The environment stays Node. The DOM tests ask for `jsdom` with a per-file docblock, so the integration
 * suites — which talk to PostgreSQL and want no DOM at all — are untouched by the addition.
 *
 * The name is set explicitly because `--project @omnichannel/web` in the root `test:e2e` script depends on
 * it, and a config file stops Vitest inferring it from `package.json`.
 */
export default defineConfig({
  test: { name: "@omnichannel/web" },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
