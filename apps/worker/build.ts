/** `pnpm --filter @omnichannel/worker build` — writes dist/main.js (see bundle.ts). */
import path from "node:path";

import { bundleWorker } from "./bundle";

await bundleWorker({ outDir: path.join(import.meta.dirname, "dist") });
