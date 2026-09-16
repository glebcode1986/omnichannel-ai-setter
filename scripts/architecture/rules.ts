/**
 * Workspace architecture rules (ADR-001, ADR-002, ADR-008, ADR-010, docs/specs/REPOSITORY_LAYOUT.md).
 *
 * This file is the single source of truth for which workspace packages may depend on which.
 * Changing an allowed edge is an architecture change: update REPOSITORY_LAYOUT.md in the same PR.
 */

export const WORKSPACE_SCOPE = "@omnichannel/";

export type PackageLayer =
  | "core" // pure domain/contracts and orchestration; no concrete infrastructure
  | "infrastructure" // implements core ports (db, queue, ai)
  | "channel-adapter" // Meta platform adapters; isolated from each other
  | "support" // infrastructure-free leaf helpers (observability, env)
  | "app"; // composition roots

export interface PackageRule {
  readonly layer: PackageLayer;
  /** Workspace packages this package may declare/import. `"all-packages"` = every non-app package. */
  readonly allowedWorkspaceDependencies: readonly string[] | "all-packages";
  /**
   * Pure packages may not use Node.js built-ins, Node.js type definitions or Node.js globals
   * (domain logic must run anywhere and must not touch process, filesystem or network directly).
   */
  readonly pure?: boolean;
  /** Third-party packages this package must never depend on or import. */
  readonly forbiddenThirdParty?: readonly string[];
}

const pkg = (name: string): string => `${WORKSPACE_SCOPE}${name}`;

/**
 * Concrete infrastructure/framework libraries that core packages must not import
 * ("core packages must not import concrete infrastructure").
 * Entries ending in `/*` match every package in that npm scope.
 */
export const CORE_FORBIDDEN_THIRD_PARTY: readonly string[] = [
  // persistence
  "prisma",
  "@prisma/*",
  "pg",
  "postgres",
  // queues / redis
  "bullmq",
  "ioredis",
  "redis",
  // UI / web framework / auth
  "next",
  "react",
  "react-dom",
  "next-auth",
  "@auth/*",
  // LLM providers (ADR-010: provider SDKs stay behind packages/ai)
  "openai",
  "@anthropic-ai/*",
  "@google/genai",
  "@ai-sdk/*",
  "ai",
  // Meta SDKs (Meta APIs are called only through channel adapters)
  "facebook-nodejs-business-sdk",
];

/**
 * Unofficial messaging transports and account automation are rejected for the product
 * (ADR-002; AGENTS.md). No workspace package — nor the root manifest — may depend on them,
 * in any dependency field. This is a best-effort denylist of known libraries, not a proof.
 */
export const GLOBALLY_FORBIDDEN_DEPENDENCIES: readonly string[] = [
  "baileys",
  "@whiskeysockets/baileys",
  "@adiwajshing/baileys",
  "whatsapp-web.js",
  "venom-bot",
  "@wppconnect-team/wppconnect",
  "@open-wa/wa-automate",
  "instagram-private-api",
];

/**
 * Browser automation (ADR-002 names Puppeteer; QR/session automation is rejected) must not ship
 * in production code. Allowed only as `devDependencies` (e.g. end-to-end tests of our own UI) and
 * only imported from test/tooling files.
 */
export const RUNTIME_FORBIDDEN_DEPENDENCIES: readonly string[] = [
  "puppeteer",
  "puppeteer-core",
  "puppeteer-extra",
  "playwright",
  "playwright-core",
  "selenium-webdriver",
];

export const PACKAGE_RULES: Readonly<Record<string, PackageRule>> = {
  [pkg("domain")]: {
    layer: "core",
    allowedWorkspaceDependencies: [],
    pure: true,
    forbiddenThirdParty: CORE_FORBIDDEN_THIRD_PARTY,
  },
  [pkg("channel-core")]: {
    layer: "core",
    allowedWorkspaceDependencies: [pkg("domain")],
    pure: true,
    forbiddenThirdParty: CORE_FORBIDDEN_THIRD_PARTY,
  },
  [pkg("application")]: {
    layer: "core",
    // `ai`: ADR-010 / AI_ORCHESTRATION.md declare the provider-neutral ReplyModel port and the
    // Zod draft contract in packages/ai; application orchestration consumes them.
    allowedWorkspaceDependencies: [pkg("domain"), pkg("channel-core"), pkg("ai")],
    forbiddenThirdParty: CORE_FORBIDDEN_THIRD_PARTY,
  },
  [pkg("db")]: {
    layer: "infrastructure",
    allowedWorkspaceDependencies: [pkg("domain"), pkg("channel-core"), pkg("application"), pkg("observability")],
  },
  [pkg("queue")]: {
    layer: "infrastructure",
    allowedWorkspaceDependencies: [pkg("domain"), pkg("channel-core"), pkg("application"), pkg("observability")],
  },
  [pkg("ai")]: {
    layer: "infrastructure",
    // No `application`: application depends on ai's contracts, so the reverse edge would be a cycle.
    allowedWorkspaceDependencies: [pkg("domain"), pkg("channel-core"), pkg("observability")],
  },
  [pkg("channel-instagram")]: {
    layer: "channel-adapter",
    allowedWorkspaceDependencies: [pkg("domain"), pkg("channel-core"), pkg("observability")],
  },
  [pkg("channel-whatsapp")]: {
    layer: "channel-adapter",
    allowedWorkspaceDependencies: [pkg("domain"), pkg("channel-core"), pkg("observability")],
  },
  [pkg("observability")]: {
    layer: "support",
    allowedWorkspaceDependencies: [],
  },
  [pkg("env")]: {
    layer: "support",
    allowedWorkspaceDependencies: [],
  },
  [pkg("web")]: {
    layer: "app",
    allowedWorkspaceDependencies: "all-packages",
  },
  [pkg("worker")]: {
    layer: "app",
    allowedWorkspaceDependencies: "all-packages",
  },
};
