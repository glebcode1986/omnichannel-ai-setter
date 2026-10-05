import { ContractValidationError, parseNormalizedChannelEvents, type NormalizedChannelEvent, type RawWebhook } from "@omnichannel/channel-core";
import {
  DEFAULT_DEBOUNCE_WINDOW_MS,
  DEFAULT_TAKEOVER_PAUSE_MS,
  isChannelType,
  isValidIdentifier,
  type DurationRangeMs,
} from "@omnichannel/domain";

import { dispatchOutbox } from "./outbox";
import type { ChannelAdapterProvider, DebounceScheduler, IngestionStore, LogPort, MediaTranscriptionScheduler, WebhookAccount } from "./ports";
import { processEvent } from "./process-event";

export interface IngestionDependencies {
  readonly store: IngestionStore;
  readonly adapters: ChannelAdapterProvider;
  readonly scheduler: DebounceScheduler;
  /** Where a reading job goes (Issue #21). The queue takes it whether or not a transcriber is configured. */
  readonly transcription: MediaTranscriptionScheduler;
  readonly log: LogPort;
  readonly now: () => Date;
  readonly random: () => number;
  /** Stage A window (DELAY_ENGINE.md); workspace/account policy lookup arrives with Phase 2 policy. */
  readonly debounceWindowMs?: DurationRangeMs;
  readonly takeoverPauseMs?: number;
  /**
   * Account-level facts some channels deliver on the same webhook endpoint (Issue #20).
   *
   * Optional, and absent on a channel that has none. WhatsApp's template status changes arrive this way
   * and are not conversation events at all: they belong to the messaging account, they produce no message
   * and nothing in them can be attributed to a contact. Routing them through the message pipeline would
   * mean an event with no conversation, so they are applied here instead — **after verification**, by a
   * port the composition root supplies, because the payload's shape is the channel's business and this
   * file is channel-neutral.
   *
   * A failure never fails the webhook: the conversation events in the same delivery still matter, and
   * Meta retries a non-200 for up to seven days, which would replay them too.
   */
  readonly accountEvents?: AccountEventPort;
}

/** Applied after a webhook has been verified; returns how many account-level facts it recorded. */
export interface AccountEventPort {
  apply(input: { readonly account: WebhookAccount; readonly webhook: RawWebhook }): Promise<number>;
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
  /**
   * Outbox entries this request handed to the queue before answering, and the ones left for the sweeper.
   *
   * Named for the outbox rather than for the debounce since Issue #21: one inbound message can write both
   * a reply cycle and a reading of its recording, and a counter that meant only the first would report a
   * voice note's dispatch as a deferral.
   */
  readonly outboxDispatched: number;
  readonly outboxDeferred: number;
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

  if (dependencies.accountEvents !== undefined) {
    try {
      const recorded = await dependencies.accountEvents.apply({ account, webhook: request.webhook });
      if (recorded > 0) {
        log.info("ingestion.account_events_recorded", { recorded });
      }
    } catch (error) {
      // Never fatal: the conversation events in this same delivery still matter, and refusing the
      // webhook would have Meta replay them for up to seven days to fix an account-level write.
      log.warn("ingestion.account_events_failed", { errorName: error instanceof Error ? error.name : typeof error });
    }
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
      outboxEntryIds.push(...(result.outboxEntryIds ?? []));
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
    outboxDispatched: dispatched,
    outboxDeferred: outboxEntryIds.length - dispatched,
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
