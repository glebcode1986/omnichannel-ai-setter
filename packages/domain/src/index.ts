/**
 * @omnichannel/domain
 *
 * Pure channel-neutral entities, value objects, enums and invariants. Pure TypeScript: no React/Next,
 * Prisma, BullMQ/Redis, Meta SDK/API, LLM provider or Node.js runtime access (enforced by
 * `pnpm lint:boundaries` and ESLint; see docs/specs/REPOSITORY_LAYOUT.md).
 */
export * from "./ai-draft";
export * from "./automation-policy";
export * from "./business-profile";
export * from "./channel";
export * from "./channel-account";
export * from "./contact";
export * from "./conversation";
export * from "./delivery";
export { literalGuard } from "./enum";
export * from "./errors";
export * from "./handoff";
export * from "./human-takeover";
export * from "./ids";
export * from "./lead";
export * from "./message";
export * from "./reason-codes";
export * from "./style-profile";
export * from "./suspension";
export * from "./values";
export * from "./workspace";
