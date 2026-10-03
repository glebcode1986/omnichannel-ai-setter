import { DEFAULT_BACKLOG_THRESHOLDS, dispatchOutbox, MODEL_OUTPUT_SCHEMA_VERSION } from "@omnichannel/application";
import { createAnthropicReplyModel } from "@omnichannel/ai";
import {
  createAiDraftStore,
  createDbClient,
  createDraftContextStore,
  createIngestionStore,
  createKnowledgeRetriever,
  createReconciliationStore,
  createStyleProfileStore,
  createStyleRetriever,
  createSuspensionStore,
  countUnusableGenerations,
  findUnresolvedOperations,
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
import { startReconciliationSweeper } from "./reconciliation-sweeper";

import { createDebounceHandler } from "./debounce-handler";
import { createDeliveryEngine } from "./delivery-engine";
import { createDeliveryHandler } from "./delivery-handler";
import { createDraftDisposition } from "./draft-disposition";
import { createHandlers } from "./handlers";
import { processGuards } from "./process-guards";
import { createShutdownSequence } from "./shutdown";
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
      const producer = createQueueProducer({ connection, logger });
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
        dispose: createDraftDisposition({
          db,
          producer,
          logger,
          now: () => new Date(),
          random: Math.random,
          // The same live answer the final gate below is given: one app-level capability, read once from
          // configuration, so the two gates cannot disagree about whether the exception exists at all.
          humanAgentApproval: env.INSTAGRAM_HUMAN_AGENT_APPROVAL,
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
      const deliver = createDeliveryHandler({
        engine: createDeliveryEngine(env, db, logger),
        logger,
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
                draft: { select: { conversationId: true } },
              },
            });
            return job === null
              ? undefined
              : {
                  workspaceId: job.workspaceId,
                  businessProfileId: job.businessProfileId,
                  correlationId: job.correlationId,
                  conversationId: job.draft.conversationId,
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
        handlers: createHandlers(generateDraft, deliver, createDebounceHandler({ producer, logger }), reconcile),
        // Every job failure is folded into an incident here rather than announced where it happened: one
        // provider outage is one thing an operator needs to know, not one per conversation.
        onJobFailure: (failure) => {
          incidents.record(failure);
        },
      });
      const sweeper = startOutboxSweeper({
        intervalMs: OUTBOX_SWEEP_INTERVAL_MS,
        sweep: () =>
          dispatchOutbox({ store: createIngestionStore(db), scheduler: producer, log: logger, now: () => new Date() }),
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
        async close() {
          // The loops first: each one holds a database or Redis handle, and closing the connection under
          // a running sweep is how shutdown produces errors that look like an outage.
          // `allSettled`, not `all`: four independent closes, and `Promise.all` leaves every rejection
          // after the first unobserved — which `process-guards.ts` answers by killing the process.
          const stopped = await Promise.allSettled([sweeper.close(), reconciliationSweeper.close(), backlogGuard.close(), health.close()]);
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
