/** Every workspace project the spread-key audit reads, shared by the report and the gate. */
export const PROJECTS = [
  "tsconfig.json",
  "apps/web/tsconfig.json",
  "apps/worker/tsconfig.json",
  "packages/ai/tsconfig.json",
  "packages/application/tsconfig.json",
  "packages/billing-stripe/tsconfig.json",
  "packages/channel-core/tsconfig.json",
  "packages/channel-instagram/tsconfig.json",
  "packages/channel-whatsapp/tsconfig.json",
  "packages/db/tsconfig.json",
  "packages/domain/tsconfig.json",
  "packages/env/tsconfig.json",
  "packages/evals/tsconfig.json",
  "packages/observability/tsconfig.json",
  "packages/queue/tsconfig.json",
] as const;
