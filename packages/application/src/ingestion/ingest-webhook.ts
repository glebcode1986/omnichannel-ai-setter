import { ContractValidationError, parseNormalizedChannelEvents, type NormalizedChannelEvent, type RawWebhook } from "@omnichannel/channel-core";
import {
  DEFAULT_DEBOUNCE_WINDOW_MS,
  DEFAULT_TAKEOVER_PAUSE_MS,
  isChannelType,
  isValidIdentifier,
  type DurationRangeMs,
} from "@omnichannel/domain";

import { dispatchOutbox } from "./outbox";
import type { ChannelAdapterProvider, DebounceScheduler, IngestionStore, LogPort } from "./ports";
import { processEvent } from "./process-event";

export interface IngestionDependencies {
  readonly store: IngestionStore;
  readonly adapters: ChannelAdapterProvider;
  readonly scheduler: DebounceScheduler;
  readonly log: LogPort;
  readonly now: () => Date;
  readonly random: () => number;
  /** Stage A window (DELAY_ENGINE.md); workspace/account policy lookup arrives with Phase 2 policy. */
  readonly debounceWindowMs?: DurationRangeMs;
  readonly takeoverPauseMs?: number;
}

export interface WebhookIngestionRequest {
  /** Route parameters; untrusted until validated here. */
  readonly channel: string;
  readonly channelAccountId: string;
  readonly webhook: RawWebhook;
  readonly correlationId: string;
}

export interface IngestionSummary {
  readonly received: number;
  readonly processed: number;
  readonly duplicates: number;
  readonly rejected: number;
  readonly debounceScheduled: number;
  readonly debounceDeferred: number;
}

export type WebhookIngestionResult =
  | { readonly kind: "CHALLENGE"; readonly responseBody: string }
  | { readonly kind: "NOT_FOUND" }
  | { readonly kind: "ADAPTER_UNAVAILABLE" }
  | { readonly kind: "UNAUTHORIZED" }
  | { readonly kind: "INVALID_PAYLOAD" }
  | { readonly kind: "ACCEPTED"; readonly summary: IngestionSummary };

/**
 * Channel-neutral webhook ingestion (P1-05):
 * resolve channel account -> Workspace + Business Profile -> verify -> normalize -> per event: validate
 * against the resolved scope, then in one transaction claim the source event, persist messages/status/
 * identity/conversation state inside that Business Profile and add outbox entries -> dispatch outbox.
 * It never calls a model and never waits for a human-like delay; debounce is a scheduled job.
 */
export async function ingestWebhook(
  dependencies: IngestionDependencies,
  request: WebhookIngestionRequest,
): Promise<WebhookIngestionResult> {
  const routeLog = withFields(dependencies.log, {
    correlationId: request.correlationId,
    channel: request.channel,
    channelAccountId: request.channelAccountId,
  });

  if (!isChannelType(request.channel) || !isValidIdentifier(request.channelAccountId)) {
    routeLog.warn("ingestion.route_invalid");
    return { kind: "NOT_FOUND" };
  }
  const account = await dependencies.store.findWebhookAccount(request.channel, request.channelAccountId);
  if (account === undefined || account.status === "DISCONNECTED") {
    routeLog.warn("ingestion.account_not_found");
    return { kind: "NOT_FOUND" };
  }
  // Everything after resolution is attributed to the account's Workspace and Business Profile.
  const log = withFields(routeLog, { workspaceId: account.workspaceId, businessProfileId: account.businessProfileId });
  const adapter = dependencies.adapters.adapterFor(account);
  if (adapter === undefined || adapter.channel !== account.channel) {
    log.warn("ingestion.adapter_unavailable");
    return { kind: "ADAPTER_UNAVAILABLE" };
  }

  // Verification happens before normalization or any persistence (CHANNEL_CONTRACTS.md invariants).
  const verification = await adapter.verifyWebhook(request.webhook);
  if (verification.status === "CHALLENGE") {
    log.info("ingestion.challenge_answered");
    return { kind: "CHALLENGE", responseBody: verification.responseBody };
  }
  if (verification.status !== "VERIFIED" || request.webhook.method !== "POST") {
    // The adapter's own `reason` never reaches the log. It is free text built from raw headers, query
    // values and body bytes, so it can carry a bearer token, a signature or part of a customer's
    // message; only this application's own closed classification is recorded.
    log.warn("ingestion.verification_failed", {
      reasonCode: verification.status === "VERIFIED" ? ("VERIFIED_NON_POST" as const) : ("ADAPTER_REJECTED" as const),
    });
    return { kind: "UNAUTHORIZED" };
  }

  let normalized: unknown[];
  try {
    normalized = await adapter.normalizeWebhook(request.webhook);
  } catch (error) {
    log.warn("ingestion.normalization_failed", { errorName: error instanceof Error ? error.name : typeof error });
    return { kind: "INVALID_PAYLOAD" };
  }

  const context = {
    correlationId: request.correlationId,
    debounceWindowMs: dependencies.debounceWindowMs ?? DEFAULT_DEBOUNCE_WINDOW_MS,
    takeoverPauseMs: dependencies.takeoverPauseMs ?? DEFAULT_TAKEOVER_PAUSE_MS,
    random: dependencies.random,
  };
  let processed = 0;
  let duplicates = 0;
  let rejected = 0;
  let dispatched = 0;
  const outboxEntryIds: string[] = [];

  try {
    for (const [index, candidate] of normalized.entries()) {
      const event = validateEvent(candidate, account, index, log);
      if (event === undefined) {
        rejected += 1;
        continue;
      }
      const result = await dependencies.store.transaction((tx) => processEvent(tx, event, context));
      if (result.status === "DUPLICATE") {
        duplicates += 1;
        log.info("ingestion.event_duplicate", { index, eventType: event.type });
        continue;
      }
      processed += 1;
      log.info("ingestion.event_processed", { index, eventType: event.type, outcome: result.outcome });
      if (result.outboxEntryId !== undefined) {
        outboxEntryIds.push(result.outboxEntryId);
      }
    }
  } finally {
    // Committed events keep their outbox entries even if a later event failed; dispatch what we have now.
    if (outboxEntryIds.length > 0) {
      dispatched = await dispatchNow(dependencies, outboxEntryIds, log);
    }
  }

  const summary: IngestionSummary = {
    received: normalized.length,
    processed,
    duplicates,
    rejected,
    debounceScheduled: dispatched,
    debounceDeferred: outboxEntryIds.length - dispatched,
  };
  log.info("ingestion.completed", { ...summary });
  return { kind: "ACCEPTED", summary };
}

async function dispatchNow(dependencies: IngestionDependencies, ids: readonly string[], log: LogPort): Promise<number> {
  try {
    return (await dispatchOutbox({ ...dependencies, log }, { ids })).dispatched;
  } catch (error) {
    // Entries stay pending and are recovered by the outbox sweeper.
    log.error("outbox.dispatch_now_failed", { errorName: error instanceof Error ? error.name : typeof error });
    return 0;
  }
}

function validateEvent(
  candidate: unknown,
  account: { readonly workspaceId: string; readonly businessProfileId: string; readonly channelAccountId: string; readonly channel: string },
  index: number,
  log: LogPort,
): NormalizedChannelEvent | undefined {
  let event: NormalizedChannelEvent | undefined;
  try {
    [event] = parseNormalizedChannelEvents([candidate]);
  } catch (error) {
    // Unknown or malformed variants are audited (paths and codes only) and skipped; they never reach storage.
    log.warn("ingestion.event_rejected", {
      index,
      reason: "INVALID_EVENT",
      issues: error instanceof ContractValidationError ? error.issues : [],
    });
    return undefined;
  }
  if (event === undefined) {
    log.warn("ingestion.event_rejected", { index, reason: "INVALID_EVENT", issues: [] });
    return undefined;
  }
  // Events must stay inside the Workspace, Business Profile, channel account and channel the route resolved.
  const mismatched = (["workspaceId", "businessProfileId", "channelAccountId", "channel"] as const).filter(
    (field) => event[field] !== account[field],
  );
  if (mismatched.length > 0) {
    log.warn("ingestion.event_rejected", { index, reason: "SCOPE_MISMATCH", fields: mismatched });
    return undefined;
  }
  return event;
}

function withFields(log: LogPort, fields: Readonly<Record<string, unknown>>): LogPort {
  return {
    info: (event, extra) => log.info(event, { ...fields, ...extra }),
    warn: (event, extra) => log.warn(event, { ...fields, ...extra }),
    error: (event, extra) => log.error(event, { ...fields, ...extra }),
  };
}
