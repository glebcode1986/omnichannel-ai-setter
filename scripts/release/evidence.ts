/**
 * What evidences each launch gate in this repository, as of this commit (#60, LAUNCH_READINESS.md).
 *
 * This is the table the release script quotes into a release record's `evidence` column, which is why it
 * lives in a module rather than inside a test: §20 asks a release to record "commands/checks and
 * results", and a table only a test could read would have meant the record said whatever the person
 * running it typed.
 *
 * Three fields, and the distinction between the first two is the point:
 *
 * - `suites` are automated tests. A path here is a claim that running it exercises the gate.
 * - `implementation` is source code offered as evidence of itself. That is **not** coverage, and keeping
 *   it in its own field is what stops a gate with no tests from looking covered: naming three production
 *   files under `suites` would have passed every check this repository had.
 * - `manual` is the honest alternative, and the valuable case. A gate with `manual` set is one no
 *   automated run can settle, and the string says what a person has to do instead.
 *
 * Several of these are `manual` because the thing they check needs a deployment, real provider
 * credentials or sustained load, and none of the three exists in this repository. Saying so is the point:
 * `LAUNCH_READINESS.md` admits a `KNOWN_LIMITATION` only when it is "explicit, bounded and safe", and an
 * unevidenced gate that nobody wrote down is none of those.
 */
export interface GateEvidence {
  /** Automated tests. Paths relative to the repository root. */
  readonly suites?: readonly string[];
  /** Source files offered as evidence of themselves. Not coverage; see the header. */
  readonly implementation?: readonly string[];
  /** What a person has to do instead, when nothing automated settles it. */
  readonly manual?: string;
}

export const GATE_EVIDENCE: Readonly<Record<string, GateEvidence>> = {
  EXACT_SHA_CI: {
    suites: ["scripts/verification/gate.test.ts"],
    implementation: [".github/workflows/verify.yml"],
  },
  STAGING: {
    manual:
      "No staging environment exists in this repository. A production-like deployment with its own PostgreSQL, Redis, storage, webhook endpoints and provider credentials has to be stood up and recorded by whoever operates it.",
  },
  MESSAGING_E2E: {
    suites: [
      "apps/worker/src/instagram-sender.integration.test.ts",
      "apps/worker/src/whatsapp-slice.integration.test.ts",
      "apps/web/src/server/webhook-ingress.integration.test.ts",
      "packages/db/src/ingestion.integration.test.ts",
      "packages/db/src/delivery-store.integration.test.ts",
      "packages/db/src/coexistence.integration.test.ts",
    ],
  },
  AUTOPILOT_HEADLESS: {
    suites: ["apps/worker/src/main.test.ts", "apps/worker/src/worker-runtime.test.ts"],
    manual:
      "The suites prove the worker's loops start and run without a browser, which is the mechanism. Observing a full inbound-to-send cycle with every dashboard closed needs a deployment and a real provider webhook.",
  },
  AI_REGRESSION: {
    suites: ["packages/evals/src/suite.test.ts"],
    implementation: ["packages/evals/src/run.ts"],
    manual:
      "`pnpm evals` is not run by CI: neither job in .github/workflows/verify.yml invokes it, so the golden-case suite is only ever run by hand. The suite file above is run by `pnpm test` and covers the harness, not the eleven case categories §5 names. Until CI runs the evals this gate is settled by a person running `pnpm evals` and recording the output.",
  },
  KNOWLEDGE_STYLE: {
    suites: [
      "packages/db/src/knowledge-store.integration.test.ts",
      "packages/db/src/style-store.integration.test.ts",
      "packages/db/src/retrieval/retrieval.integration.test.ts",
      "packages/db/src/retrieval/boundary.test.ts",
      "apps/web/src/server/style-screen.integration.test.ts",
    ],
  },
  HUMAN_REVIEW_RACE: {
    suites: [
      "packages/db/src/review-store.integration.test.ts",
      "packages/db/src/composer-store.integration.test.ts",
      "apps/worker/src/review-delivery.integration.test.ts",
      "packages/db/src/conversation-operations-store.integration.test.ts",
    ],
  },
  TENANT_ISOLATION: {
    suites: [
      "packages/db/src/tenancy.integration.test.ts",
      "packages/db/src/constraints.integration.test.ts",
      "apps/web/src/server/shell-authorization.integration.test.ts",
    ],
  },
  RELIABILITY_CHAOS: {
    suites: [
      "apps/worker/src/kill-switch.integration.test.ts",
      "apps/worker/src/kill-switch-race.integration.test.ts",
      "apps/worker/src/reliability.integration.test.ts",
    ],
    manual:
      "The suites fail dependencies the way the code can be made to fail them in-process. Disabling a real AI provider, a real Redis or a real channel credential in a running deployment, and watching recovery, needs staging.",
  },
  LOAD_CONCURRENCY: {
    suites: ["packages/db/src/delivery-store.integration.test.ts", "apps/worker/src/kill-switch-race.integration.test.ts"],
    manual:
      "The suites cover the correctness properties under contention — atomic claims, duplicate workers, interleaved writes. Sustained burst load above expected traffic needs an environment that can generate it.",
  },
  BILLING_ENTITLEMENT: {
    suites: [
      "packages/db/src/entitlements.integration.test.ts",
      "packages/db/src/usage-store.integration.test.ts",
      "packages/db/src/catalog.integration.test.ts",
      "packages/db/src/billing-routing.integration.test.ts",
      "apps/web/src/server/billing-screen.integration.test.ts",
      "apps/web/src/server/checkout-screen.integration.test.ts",
    ],
    manual:
      "Everything except a real provider event. No billing provider adapter exists yet (#41), so a verified settlement is exercised through a stub adapter rather than a provider.",
  },
  PRIVACY_DELETION: {
    suites: [
      "packages/db/src/privacy.integration.test.ts",
      "packages/db/src/deletion.integration.test.ts",
      "packages/db/src/audit-store.integration.test.ts",
    ],
  },
  MEDIA: {
    suites: ["apps/worker/src/transcription-handler.integration.test.ts", "packages/db/src/transcript-store.integration.test.ts"],
  },
  BOOKING: {
    manual:
      "No booking capability exists in this repository. The gate is a KNOWN_LIMITATION for any release that leaves it disabled, which is every release so far.",
  },
  UX_LOCALIZATION: {
    suites: [
      "apps/web/src/i18n/no-unlocalized-strings.test.ts",
      "apps/web/src/i18n/translate.test.ts",
      "apps/web/src/i18n/dashboard-locale-isolation.integration.test.ts",
      "apps/web/src/a11y/semantics.test.ts",
      "apps/web/src/a11y/contrast.test.ts",
      "apps/web/src/responsive/breakpoints.test.ts",
    ],
  },
  OBSERVABILITY: {
    implementation: ["apps/worker/src/health-reporter.ts", "apps/worker/src/backlog-guard.ts", "apps/web/src/app/api/health/route.ts"],
    manual:
      "Nothing automated settles this one, and the three files above are the implementation rather than evidence about it. Health is computed and logged, and the console (#59) shows pause state and ambiguous operations. There is no alerting integration and no runbook document, so every alert §16 requires is unevidenced.",
  },
  KILL_SWITCHES: {
    suites: ["apps/worker/src/kill-switch.integration.test.ts", "packages/db/src/platform-operations.integration.test.ts"],
    manual: "Kill switches exist at four of the six scopes §17 names. A channel/provider class and a high-risk-feature scope do not exist yet.",
  },
  STAGED_ROLLOUT: {
    suites: [
      "packages/domain/src/release.test.ts",
      "packages/db/src/release-store.integration.test.ts",
      "packages/db/src/release-lock.integration.test.ts",
      "packages/db/src/delivery-store.integration.test.ts",
      "packages/application/src/policy/evaluate.test.ts",
    ],
  },
  PER_CUSTOMER_READINESS: {
    suites: ["packages/db/src/onboarding-store.integration.test.ts", "apps/web/src/server/style-screen.integration.test.ts"],
    manual:
      "Onboarding readiness is computed and gates activation. The rest of §19's per-profile checklist — objectives configured, Test Drive acceptable, no unresolved operational blocker — is an operator judgement, not a suite.",
  },
  RELEASE_EVIDENCE: {
    suites: ["packages/db/src/release-store.integration.test.ts", "scripts/release/gates.test.ts"],
  },
};

/**
 * The one line a release record stores for a gate, assembled from the table above.
 *
 * Both halves, when both exist: the suites that were run and the admission of what they do not settle. A
 * record that quoted only the suites would be the "looks fine" the spec refuses, dressed as a file list.
 */
export function evidenceLineFor(gateId: string): string {
  const entry = GATE_EVIDENCE[gateId];
  if (entry === undefined) {
    return "";
  }
  const parts: string[] = [];
  if ((entry.suites ?? []).length > 0) {
    parts.push(`suites: ${(entry.suites ?? []).join(", ")}`);
  }
  if ((entry.implementation ?? []).length > 0) {
    parts.push(`implementation (not coverage): ${(entry.implementation ?? []).join(", ")}`);
  }
  if ((entry.manual ?? "").trim() !== "") {
    parts.push(`not settled automatically: ${(entry.manual ?? "").trim()}`);
  }
  return parts.join(" | ");
}

/** Whether anything automated covers this gate at all. The release script turns this into a severity. */
export function automatedCoverageFor(gateId: string): boolean {
  return (GATE_EVIDENCE[gateId]?.suites ?? []).length > 0;
}
