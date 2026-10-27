import { DEFAULT_BACKLOG_THRESHOLDS, dispatchOutbox, MODEL_OUTPUT_SCHEMA_VERSION } from "@omnichannel/application";
import { createAnthropicReplyModel } from "@omnichannel/ai";
import { MARK_READ_MAX_AGE_MS, TYPING_INDICATOR_TTL_MS } from "@omnichannel/channel-whatsapp";
import {
  claimFollowUp,
  createAiDraftStore,
  createDbClient,
  createDraftContextStore,
  createIngestionStore,
  createKnowledgeRetriever,
  createReconciliationStore,
  createStyleProfileStore,
  createPresenceStore,
  deleteExpiredChannelConnectStates,
  expireStaleCheckouts,
  expireStaleReservations,
  createStyleRetriever,
  createSuspensionStore,
  countUnusableGenerations,
  dueFollowUps,
  findUnresolvedOperations,
  recordFollowUpSent,
  readReliabilitySnapshot,
  recoverStaleSendingDeliveries,
} from "@omnichannel/db";
import { EnvValidationError } from "@omnichannel/env";
import { resolveStyleProfile } from "@omnichannel/domain";
import { createLogger } from "@omnichannel/observability";
import { AI_DRAFT_GENERATION, createQueueMonitor, createQueueProducer, createQueueWorkers, createRedisConnection, DELIVERY, RECONCILIATION } from "@omnichannel/queue";

import { createEmbeddings } from "./embeddings";
import { loadWorkerEnv } from "./env";
import { randomUUID } from "node:crypto";

import { createAiDraftHandler } from "./ai-draft-handler";
import { startBacklogGuard } from "./backlog-guard";
import { aiProviderProbe, channelAccountProbes, databaseProbe, queueProbe } from "./health-probes";
import { startHealthReporter } from "./health-reporter";
import { createIncidentReporter } from "./incident-reporter";
import { createOperationEvidencePort } from "./operation-evidence";
import { createDeliveryResumer, createReconcileHandler } from "./reconcile-handler";
import { startInstagramTokenRefresh } from "./instagram-token-sweeper";
import { startReconciliationSweeper } from "./reconciliation-sweeper";
import { startRetentionSweeper } from "./retention-sweeper";
import { startBillingSweeper } from "./billing-sweeper";
import { startUsageSweeper } from "./usage-sweeper";

import { createDebounceHandler } from "./debounce-handler";
import { createTranscription } from "./transcription";
import { createTranscriptionHandler } from "./transcription-handler";
import { createMediaPort } from "./media-port";
import { createPresenceHandler } from "./presence-handler";
import { createPresenceAnnouncer } from "./presence-port";
import { createDeliveryEngine, deliverableChannels } from "./delivery-engine";
import { createDeliveryHandler } from "./delivery-handler";
import { createDraftDisposition } from "./draft-disposition";
import { createHandlers } from "./handlers";
import { processGuards } from "./process-guards";
import { createShutdownSequence } from "./shutdown";
import { automatedRouteStillOpen } from "./followup-channel";
import { startFollowUpSweeper } from "./followup-sweeper";
import { startOutboxSweeper } from "./outbox-sweeper";
import { createWorkerRuntime } from "./worker-runtime";

const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
/** How often the operational picture is recomputed, and how often each recovery loop runs. */
const HEALTH_INTERVAL_MS = 30_000;
const RECONCILIATION_SWEEP_INTERVAL_MS = 60_000;
const BACKLOG_GUARD_INTERVAL_MS = 30_000;
/** An unresolved operation is asked about again no more often than this. */
const RECONCILIATION_RETRY_AFTER_MS = 120_000;
const RECONCILIATION_BATCH = 100;
/**
 * How often due follow-ups are looked for, and how many one pass takes (#55).
 *
 * A minute, like the reconciliation sweep: a follow-up is scheduled in hours and a minute of lateness is
 * invisible to a customer, while a tighter loop would mean a cross-tenant scan every few seconds for work
 * that is almost never there. The batch is a bound, so one busy minute cannot starve the next pass.
 */
const FOLLOW_UP_SWEEP_INTERVAL_MS = 60_000;
const FOLLOW_UP_BATCH = 50;
/** Failures fold into incidents over this window; the cap is a storm backstop, not a tuning knob. */
const INCIDENT_WINDOW_MS = 15 * 60_000;
const INCIDENT_SIGNAL_LIMIT = 5_000;
/** Sustained, or spread across conversations: either is enough to be worth telling someone about. */
const INCIDENT_THRESHOLDS = { occurrences: 20, conversations: 5 };
/** Unusable generations in the window above which the provider is called degraded, not broken. */
const AI_DEGRADED_FAILURES = 5;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const OUTBOX_SWEEP_INTERVAL_MS = 5_000;
/**
 * How often expired short-lived rows are swept.
 *
 * An hour, because nothing waits on it: a connect state is already unusable the moment it expires, and
 * the sweep is about not keeping it, not about enforcing the expiry (#57).
 */
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60_000;
/**
 * Minutes rather than hours, unlike the retention sweep.
 *
 * What this gives back is a customer's own allowance, held by a reservation whose worker died. An expired
 * OAuth nonce costs nothing by waiting; transcription minutes a business cannot use because of our crash
 * cost them the thing they paid for.
 */
const USAGE_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * How often an abandoned checkout's charge path is released (#46).
 *
 * A quote's own expiry is usually minutes, so a quarter of an hour is soon enough that a customer who
 * came back to buy is not refused for long, and rare enough that the sweep is not a poll.
 */
const CHECKOUT_SWEEP_INTERVAL_MS = 15 * 60_000;
/**
 * One Ctrl+C reaches the worker several times (terminal process group plus relays by pnpm/tsx), so
 * repeats within this window are the same request. A later signal while still stopping forces exit.
 */
const DUPLICATE_SIGNAL_WINDOW_MS = 2_000;
/** Bumped whenever the prompt changes, and persisted with every draft so output stays attributable. */
const PROMPT_VERSION = "reply.v1";

function main(): void {
  let env;
  try {
    env = loadWorkerEnv();
  } catch (error) {
    const bootLogger = createLogger({ level: "error", bindings: { service: "worker" } });
    bootLogger.error("worker.env_invalid", {
      // EnvValidationError is value-free by construction; anything else is reduced to its name
      // because an unexpected error message could quote a configuration value.
      ...(error instanceof EnvValidationError
        ? { issues: error.issues }
        : { errorName: error instanceof Error ? error.name : typeof error }),
    });
    process.exitCode = 1;
    return;
  }

  const logger = createLogger({ level: env.LOG_LEVEL, bindings: { service: "worker" } });
  const runtime = createWorkerRuntime({
    logger,
    startProcessors: () => {
      const connection = createRedisConnection(env.REDIS_URL, "worker", logger);
      const db = createDbClient({ connectionString: env.DATABASE_URL });
      // Provider choice is configuration: the model ID and key come from the validated environment, and
      // nothing below this line knows which provider is in use.
      const replyModel = createAnthropicReplyModel({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.AI_REPLY_MODEL,
        maxOutputTokens: env.AI_REPLY_MAX_OUTPUT_TOKENS,
        logger,
      });
      // No embeddings key means lexical-only retrieval, which is supported: retrieval still runs and a
      // fact it misses becomes MISSING_FACT and human review rather than an invented answer.
      const embeddings = createEmbeddings(env, logger);
      // Stated at boot, not inferred from silence: lexical-only is a supported mode, but an operator has
      // to be able to see which mode a worker is actually in before a customer asks a factual question.
      logger.info("worker.retrieval_mode", { semantic: embeddings !== undefined, lexical: true });
      // The same shape of decision for recordings: no key means a voice note is recorded as unread and
      // the reply waits for a person, which is a configuration rather than a fault (Issue #21).
      const transcription = createTranscription(env, logger);
      logger.info("worker.transcription_mode", { enabled: transcription !== undefined, model: env.AI_TRANSCRIPTION_MODEL });
      const transcribeMedia = createTranscriptionHandler({
        db,
        media: createMediaPort(env, db, logger),
        ...(transcription === undefined ? {} : { transcription }),
        deleteMediaAfterReading: env.MEDIA_RETENTION === "DELETE_AFTER_READING",
        logger,
        now: () => new Date(),
      });
      const producer = createQueueProducer({ connection, logger });
      // One value, read once from the configuration that builds the sender, and handed to the only other
      // component that needs it. A typing indicator for a reply this process would refuse to send is the
      // one presence failure a customer actually notices (#22).
      const deliverable = deliverableChannels(env);
      const presenceAnnouncer = createPresenceAnnouncer(env, db, logger);
      logger.info("worker.presence_mode", { announcer: presenceAnnouncer !== undefined, deliverableChannels: [...deliverable] });
      const generateDraft = createAiDraftHandler({
        engine: {
          model: replyModel,
          drafts: createAiDraftStore(db),
          log: logger,
          now: () => new Date(),
          newNonce: randomUUID,
          promptVersion: PROMPT_VERSION,
          schemaVersion: MODEL_OUTPUT_SCHEMA_VERSION,
          timeoutMs: env.AI_REPLY_TIMEOUT_MS,
        },
        context: createDraftContextStore(db),
        // A follow-up attempt that reached a scheduled operation stops being claimable and names the send
        // it produced. Only this; an attempt whose draft was held or skipped is settled by the next claim,
        // so what an unsent attempt means is decided in one place.
        recordFollowUpSent: ({ followUpId, operationId }) => recordFollowUpSent(db, followUpId, operationId),
        dispose: createDraftDisposition({
          db,
          producer,
          logger,
          now: () => new Date(),
          random: Math.random,
          // The same live answer the final gate below is given: one app-level capability, read once from
          // configuration, so the two gates cannot disagree about whether the exception exists at all.
          humanAgentApproval: env.INSTAGRAM_HUMAN_AGENT_APPROVAL,
          // Absent when nothing could be announced anyway, so no job is queued that would only decline.
          ...(presenceAnnouncer === undefined ? {} : { presence: { typingTtlMs: TYPING_INDICATOR_TTL_MS, deliverableChannels: deliverable } }),
        }),
        retrieval: {
          knowledge: createKnowledgeRetriever(db),
          style: createStyleRetriever(db),
          ...(embeddings === undefined ? {} : { embeddings }),
          log: logger,
        },
        styleProfiles: createStyleProfileStore(db),
        platformStyleFallback: resolveStyleProfile([{ persona: env.AI_PERSONA }]),
        logger,
      });
      const deliveryEngine = createDeliveryEngine(env, db, logger);
      const deliver = createDeliveryHandler({ engine: deliveryEngine, logger });
      const announcePresence = createPresenceHandler({
        store: createPresenceStore(db),
        ...(presenceAnnouncer === undefined ? {} : { announcer: presenceAnnouncer }),
        // The same derivation the coordinator is given, so the two judge one set of channel facts rather
        // than two that can disagree about whether this reply may still go out.
        channel: deliveryEngine.channel,
        markReadMaxAgeMs: MARK_READ_MAX_AGE_MS,
        logger,
        now: () => new Date(),
      });
      const reconcile = createReconcileHandler({
        engine: {
          store: createReconciliationStore(db),
          // Honest by construction: Meta cannot resolve a send request to a message after the fact, so
          // this answers UNKNOWN and the operation ends up in front of a person rather than guessed at.
          evidence: createOperationEvidencePort(),
          log: logger,
          now: () => new Date(),
          graceMs: env.RECONCILE_GRACE_MS,
        },
        resumeDelivery: createDeliveryResumer(
          async (operationId) => {
            const job = await db.deliveryJobRecord.findUnique({
              where: { operationId },
              select: {
                workspaceId: true,
                businessProfileId: true,
                correlationId: true,
                id: true,
                draftId: true,
                scheduledFor: true,
                selectedDelayMs: true,
                // A human-composed delivery names its conversation directly; an AI one reaches it
                // through the draft. Both are selected so one reader serves either origin.
                conversationId: true,
                draft: { select: { conversationId: true } },
              },
            });
            return job === null
              ? undefined
              : {
                  workspaceId: job.workspaceId,
                  businessProfileId: job.businessProfileId,
                  correlationId: job.correlationId,
                  // Either origin. Exactly one is present, which a CHECK guarantees (ADR-018 Option B).
                  conversationId: job.draft?.conversationId ?? job.conversationId ?? "",
                  deliveryJobId: job.id,
                  draftId: job.draftId,
                  scheduledFor: job.scheduledFor,
                  selectedDelayMs: job.selectedDelayMs,
                };
          },
          producer,
          logger,
        ),
        logger,
      });
      const incidents = createIncidentReporter({
        logger,
        windowMs: INCIDENT_WINDOW_MS,
        limit: INCIDENT_SIGNAL_LIMIT,
        thresholds: INCIDENT_THRESHOLDS,
        now: () => new Date(),
      });
      const workers = createQueueWorkers({
        connection,
        logger,
        handlers: createHandlers(generateDraft, deliver, createDebounceHandler({ producer, logger }), transcribeMedia, announcePresence, reconcile),
        // Every job failure is folded into an incident here rather than announced where it happened: one
        // provider outage is one thing an operator needs to know, not one per conversation.
        onJobFailure: (failure) => {
          incidents.record(failure);
        },
      });
      const retention = startRetentionSweeper({
        intervalMs: RETENTION_SWEEP_INTERVAL_MS,
        deleteExpiredConnectStates: (before) => deleteExpiredChannelConnectStates(db, before),
        logger,
        now: () => new Date(),
      });
      const usage = startUsageSweeper({
        intervalMs: USAGE_SWEEP_INTERVAL_MS,
        releaseStaleReservations: (at) => expireStaleReservations(db, at),
        logger,
        now: () => new Date(),
      });
      const billing = startBillingSweeper({
        intervalMs: CHECKOUT_SWEEP_INTERVAL_MS,
        expireStaleCheckouts: (at) => expireStaleCheckouts(db, at),
        logger,
        now: () => new Date(),
      });
      const sweeper = startOutboxSweeper({
        intervalMs: OUTBOX_SWEEP_INTERVAL_MS,
        sweep: () =>
          dispatchOutbox({ store: createIngestionStore(db), scheduler: producer, transcription: producer, log: logger, now: () => new Date() }),
        logger,
      });
      const suspensions = createSuspensionStore(db);
      const monitor = createQueueMonitor({ connection, logger });
      const reconciliationSweeper = startReconciliationSweeper({
        intervalMs: RECONCILIATION_SWEEP_INTERVAL_MS,
        retryAfterMs: RECONCILIATION_RETRY_AFTER_MS,
        limit: RECONCILIATION_BATCH,
        recoverStaleClaims: () => recoverStaleSendingDeliveries(db, env.RELIABILITY_STALE_CLAIM_MS, new Date()),
        findUnresolved: (options) => findUnresolvedOperations(db, options),
        producer,
        logger,
        now: () => new Date(),
      });
      // Without this, every part of the Instagram token lifecycle is implemented and none of it runs: a
      // 60-day token expires, the account still reads CONNECTED, and every reply fails with a provider
      // error nobody was warned about.
      const tokenRefresh = startInstagramTokenRefresh(env, db, logger);
      // What makes a planned follow-up happen (#55). Without it `dueFollowUps` and `claimFollowUp` had no
      // caller at all, so the feature existed and never ran. It enqueues the same AI-draft job an inbound
      // message would: there is no second send path, and every gate is re-asked inside the claim.
      const followUpSweeper = startFollowUpSweeper({
        intervalMs: FOLLOW_UP_SWEEP_INTERVAL_MS,
        limit: FOLLOW_UP_BATCH,
        due: ({ now, limit }) => dueFollowUps(db, now, limit),
        // The window question, asked inside the claim's own transaction with the facts it read under the
        // lock. It can only decline to generate, never permit a send: see `followup-channel.ts`.
        claim: (followUpId, now) => claimFollowUp(db, followUpId, now, { carries: automatedRouteStillOpen }),
        producer,
        logger,
        now: () => new Date(),
        newCorrelationId: randomUUID,
      });
      const backlogGuard = startBacklogGuard({
        intervalMs: BACKLOG_GUARD_INTERVAL_MS,
        thresholds: {
          waiting: env.BACKLOG_WAITING_LIMIT,
          oldestWaitingMs: env.BACKLOG_OLDEST_WAITING_MS,
          clearFraction: DEFAULT_BACKLOG_THRESHOLDS.clearFraction,
          suspendForMs: DEFAULT_BACKLOG_THRESHOLDS.suspendForMs,
        },
        depths: () => monitor.depths(),
        suspensions,
        logger,
        now: () => new Date(),
        // Outbound work only. A pile of inbound messages waiting to be stored is a reason to hurry, and
        // stopping there would lose customer data that no retry can bring back.
        watched: [AI_DRAFT_GENERATION.queueName, DELIVERY.queueName, RECONCILIATION.queueName],
      });
      const health = startHealthReporter({
        intervalMs: HEALTH_INTERVAL_MS,
        probes: async () => {
          const accounts = await db.channelAccount.findMany({ select: { id: true, status: true } });
          return [
            databaseProbe(db),
            queueProbe(connection),
            aiProviderProbe(env.AI_REPLY_MODEL, () => countUnusableGenerations(db, new Date(Date.now() - INCIDENT_WINDOW_MS)), AI_DEGRADED_FAILURES),
            ...channelAccountProbes(accounts),
          ];
        },
        snapshot: (now) => readReliabilitySnapshot(db, now),
        depths: () => monitor.depths(),
        incidents,
        logger,
        now: () => new Date(),
      });
      return {
        queueNames: workers.queueNames,
        // Built from what actually started, not from a list written by hand: a loop that is wired to
        // nothing has to be visible as an absence here. The Instagram token refresh was written, tested
        // and never called, and this is where that would have shown.
        // `retention`, `usage_reservations`, `checkout_expiry` and `follow_ups` unconditionally and
        // `instagram_tokens` conditionally, which is the difference between the loops rather than an
        // inconsistency: the sweepers always start, and the token refresh only runs where it is
        // configured, so its absence here is information.
        loops: [
          "outbox",
          "reconciliation",
          "retention",
          "usage_reservations",
          "checkout_expiry",
          ...(tokenRefresh.running ? ["instagram_tokens"] : []),
          "follow_ups",
          "backlog_guard",
          "health",
        ],
        async close() {
          // The loops first: each one holds a database or Redis handle, and closing the connection under
          // a running sweep is how shutdown produces errors that look like an outage.
          // `allSettled`, not `all`: nine independent closes, and `Promise.all` leaves every rejection
          // after the first unobserved — which `process-guards.ts` answers by killing the process.
          const stopped = await Promise.allSettled([
            sweeper.close(),
            reconciliationSweeper.close(),
            retention.close(),
            usage.close(),
            billing.close(),
            tokenRefresh.close(),
            followUpSweeper.close(),
            backlogGuard.close(),
            health.close(),
          ]);
          for (const outcome of stopped) {
            if (outcome.status === "rejected") {
              logger.warn("worker.loop_close_failed", {
                errorName: outcome.reason instanceof Error ? outcome.reason.name : typeof outcome.reason,
              });
            }
          }
          await workers.close();
          await monitor.close();
          await producer.close();
          await connection.quit().catch(() => connection.disconnect());
          await db.$disconnect();
        },
      };
    },
  });

  const guards = processGuards({
    logger,
    exit: (code) => {
      process.exit(code);
    },
  });
  process.on("uncaughtException", guards.onUncaughtException);
  process.on("unhandledRejection", guards.onUnhandledRejection);

  const onShutdownSignal = createShutdownSequence({
    runtime,
    logger,
    exit: (code) => {
      process.exit(code);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    now: () => Date.now(),
    schedule: (ms, run) => {
      // Unref'd: the deadline bounds the wait, it must never be the reason the process is still alive.
      setTimeout(run, ms).unref();
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    duplicateWindowMs: DUPLICATE_SIGNAL_WINDOW_MS,
  });

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, onShutdownSignal);
  }

  runtime.start();
}

main();
