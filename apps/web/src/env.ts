import { parseEnv, runtimeEnvSchema, type EnvSource } from "@omnichannel/env";
import { z } from "zod";

/**
 * Server-side web environment contract. Never expose these values to client components.
 */
export const webEnvSchema = runtimeEnvSchema.extend({
  /** PostgreSQL connection string (ADR-005). */
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  /** Auth.js secret used to sign/encrypt session cookies and tokens (ADR-009). */
  AUTH_SECRET: z.string().min(32),

  /**
   * The absolute origin this deployment is reached at, for the links sign-in sends (#117, ADR-022).
   *
   * Configured, never derived from the incoming request, for the same reason `INSTAGRAM_REDIRECT_URI` is:
   * `Host` is a header. A one-time sign-in link built from one is a link an attacker can point at their
   * own page while the token in it is still valid for this deployment — the whole credential, delivered
   * to them. Optional, because a deployment that offers no sign-in must still boot; absent, **no sign-in
   * method is offered at all** rather than one that mails links to wherever a request claimed to come
   * from.
   *
   * `http` is permitted so a developer can run the flow locally; `sign-in-methods.ts` refuses a
   * non-HTTPS origin outside development, where a link and a session cookie would cross the network in
   * the clear.
   *
   * **Named `AUTH_URL` because that is the variable Auth.js itself reads**, and in the installed version
   * it is the *only* way to detach the origin from the request: `send-token.ts` builds the link from
   * `options.url.origin`, and `@auth/core`'s own `setEnvDefaults` takes that origin from `AUTH_URL ??
   * NEXTAUTH_URL`, falling back to `x-forwarded-host` or `host` when neither is set. A second variable of
   * our own would have been read by nothing — and would have produced a page that claims a method is
   * available while the library mails links built from a header.
   *
   * Setting it also flips Auth.js's `trustHost` to true, which is correct *because* it is set: the origin
   * then comes from configuration rather than from the request. Absent in production, `trustHost` stays
   * false and the whole auth endpoint answers with a configuration error — which is why
   * `availableSignInMethods` withholds both methods without it, so the page says so instead of offering
   * a button into that error.
   */
  AUTH_URL: z.url({ protocol: /^https?$/ }).optional(),

  /**
   * Google OAuth/OIDC client for sign-in and registration (owner decision 2026-10-28, ADR-022).
   *
   * Both or neither: an id without a secret is a method that cannot complete, and
   * `availableSignInMethods` reports a half-configured client as unavailable rather than rendering a
   * button that fails at the provider. Identity only — the scopes requested are `openid email profile`
   * and nothing else, so this client can read who somebody is and never act for them.
   *
   * The secret stays in validated environment: `parseEnv` reports a failure by variable name and never
   * by value, and nothing logs or returns these.
   */
  GOOGLE_CLIENT_ID: z.string().min(1).max(256).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).max(256).optional(),

  /**
   * SMTP transport for the one-time sign-in link, as a connection URL (#117).
   *
   * A URL rather than a vendor's API key, because the accepted decision names "email one-time magic
   * link" and not a particular sender: any SMTP service a deployment already trusts satisfies it, and
   * nothing in the product is coupled to one. Optional and paired with the sender identity — absent or
   * half-present, the email method is **not offered**, which is the fail-closed behaviour the task
   * requires: a sign-in form that accepts an address and silently cannot deliver is worse than one that
   * says the method is unavailable.
   *
   * Deliverability — a verified sending domain with SPF, DKIM and DMARC — is a deployment property this
   * cannot check and does not claim. See `docs/handoff/AUTH_SETUP.md`.
   */
  AUTH_EMAIL_SERVER: z.string().min(1).max(1_024).optional(),
  /** The `From` identity those links are sent as, e.g. `Omnichannel <no-reply@example.com>`. */
  AUTH_EMAIL_FROM: z.string().min(3).max(320).optional(),

  /**
   * Whether this deployment registers anybody who asks, or only the addresses it was given (#133).
   *
   * `open` is the accepted public self-serve behaviour of #117 and the default when the variable is
   * absent. `invite` is the private pilot: the email method is still offered, but a link is only ever
   * sent to an address in `AUTH_INVITE_ALLOWLIST`, and a request for any other address is answered
   * exactly as a sent one is.
   *
   * **An enum rather than a free string, so a typo cannot open registration.** A gate whose mode is read
   * from an unvalidated variable is one `AUTH_SIGN_IN_ACCESS=invitee` away from admitting the public,
   * and nothing downstream would report it: the page would render, the mail would send, and the only
   * sign would be customers nobody invited. Refusing to boot is the loud failure this deserves.
   */
  AUTH_SIGN_IN_ACCESS: z.enum(["open", "invite"]).optional(),

  /**
   * The addresses invited to the private pilot, separated by commas, semicolons or newlines (#133).
   *
   * Read only when `AUTH_SIGN_IN_ACCESS` is `invite`. Deployment configuration rather than a table,
   * because the pilot is a handful of known businesses and nothing in the product can yet create the
   * first platform member who would administer a table — an invitation anybody can grant needs a
   * management surface and an audit trail, and the smallest honest version of that is the operator
   * editing the deployment's own environment. Revocation is removing the address and restarting; the
   * link an uninvited address already holds stops working, because the gate is consulted again when a
   * link is spent, not only when one is asked for.
   *
   * **Empty invites nobody.** See `sign-in-invitations.ts` — a list that happens to be empty must not
   * read as "no restriction".
   */
  AUTH_INVITE_ALLOWLIST: z.string().max(8_192).optional(),

  /**
   * The request header this deployment's own proxy sets to the caller's address, e.g. `x-forwarded-for`
   * (#117).
   *
   * Named by configuration and **not** assumed, because a header is whatever the caller says it is unless
   * something in front of this process overwrites it. Nothing else in this repository reads a client
   * address and no reverse-proxy contract is checked in, so there is nothing to appeal to: a limiter keyed
   * on a header this deployment does not actually control reads as protection and provides none — an
   * attacker rotates the value and an ordinary person behind the same corporate NAT is refused instead.
   *
   * Absent, the per-caller sign-in limit is simply **not applied** — not applied to one shared bucket,
   * which would be a global sign-in outage after twenty attempts. The per-address limit does not depend on
   * this and is always enforced.
   */
  AUTH_TRUSTED_CLIENT_IP_HEADER: z.string().min(1).max(64).optional(),

  /**
   * Where the published documentation lives.
   *
   * Optional, and the navigation item exists only when it is set. `doc.keepsaybot.online` resolves to
   * the deployment host already but serves nothing and has no certificate covering it, so a link added
   * today would take a reader to a connection failure. Configuring the address is what turns the item
   * on, which keeps "there is a link" and "there is a site" the same fact.
   */
  WEB_DOCS_URL: z.url({ protocol: /^https$/ }).max(512).optional(),
  /** Redis for enqueueing BullMQ work from webhook ingestion (ADR-005). */
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  /** Identifies the key that encrypts stored provider credentials; rows record it so keys can be rotated. */
  CHANNEL_CREDENTIAL_KEY_ID: z.string().min(1).max(64),
  /** 32-byte AES-256-GCM key, base64 encoded (44 characters). Never logged, never sent to the browser. */
  CHANNEL_CREDENTIAL_KEY: z.base64().length(44),
  /** Meta app credentials for Instagram Login (ADR-006). */
  INSTAGRAM_APP_ID: z.string().min(1).max(64),
  INSTAGRAM_APP_SECRET: z.string().min(1).max(256),
  /** Exactly the HTTPS redirect URI registered with Meta; never derived from an incoming request. */
  INSTAGRAM_REDIRECT_URI: z.url({ protocol: /^https$/ }),
  /**
   * Token echoed back to Meta during the webhook subscription handshake. Optional so a deployment that
   * does not receive Instagram webhooks still boots; where it is absent no Instagram adapter is bound at
   * all, so webhooks are refused before signature verification, persistence or enqueue rather than
   * accepted unverified. Validated for shape when present, and never logged or returned in a response.
   */
  INSTAGRAM_VERIFY_TOKEN: z.string().min(16).max(256).optional(),
  /**
   * Whether Meta approved the Human Agent feature for this app. No API exposes it, so it is operator-entered
   * and defaults to UNKNOWN, which keeps the human-agent send path closed.
   */
  INSTAGRAM_HUMAN_AGENT_APPROVAL: z.enum(["APPROVED", "NOT_APPROVED", "UNKNOWN"]).default("UNKNOWN"),

  /**
   * Where a provider sends a customer back to, as an absolute HTTPS origin (Issue #41).
   *
   * Configured, never derived from the incoming request, for the same reason `INSTAGRAM_REDIRECT_URI` is:
   * `Host` is a header, and a success URL built from one is a success URL an attacker can point at their
   * own page. Optional — without it no checkout hand-off is offered at all, because a hand-off with
   * nowhere to return to would leave a paying customer on the provider's page with no way back.
   */
  BILLING_RETURN_BASE_URL: z.url({ protocol: /^https$/ }).optional(),

  /**
   * The Stripe accounts this deployment can bill through, one per `BillingRoute` (Issue #41, ADR-020).
   *
   * A list because one process serves more than one seller: ADR-019 binds each route to exactly one
   * seller profile and exactly one provider account, and the P6-04 decision keeps the Ukrainian FOP and
   * the Romanian company as separate legal entities whose events must never meet. A single
   * `STRIPE_SECRET_KEY` could not express that, and a second route would need a code change to exist.
   *
   * JSON, validated here, and never logged: `parseEnv` turns a failure into an error that names the
   * variable and no value, so a malformed list cannot print a key. Optional, because a deployment that
   * does not take payments must still boot — and where it is absent no Stripe adapter is registered at
   * all, so a billing webhook is refused before verification rather than accepted unverified.
   *
   * `webhookSecrets` is a list of one, or of two while an endpoint secret is being rolled: Stripe keeps
   * the previous secret active for up to 24 hours and signs each delivery once per active secret.
   */
  STRIPE_ROUTES: z
    .string()
    .transform((value) => JSON.parse(value) as unknown)
    .pipe(
      z
        .array(
          z.object({
            /** The product's own `billing_routes.code`. Never a Stripe identifier. */
            routeCode: z.string().min(1).max(64),
            /** A restricted key is preferred to a secret one; both are accepted and neither is logged. */
            secretKey: z.string().min(1).max(256),
            webhookSecrets: z.array(z.string().min(1).max(256)).min(1).max(2),
          }),
        )
        .min(1)
        .max(8)
        // Duplicated route codes would silently drop one account's configuration, and the one that
        // vanished would be the one whose webhooks then verified against the wrong secret.
        .refine((routes) => new Set(routes.map((route) => route.routeCode)).size === routes.length, {
          message: "each billing route code appears once",
        }),
    )
    .optional(),

  /**
   * Meta app credentials for WhatsApp Embedded Signup (ADR-015, Issue #19).
   *
   * All three are optional so a deployment that does not offer WhatsApp still boots; where any is absent
   * the connect flow is not composed at all, so the endpoint refuses before touching a database rather
   * than starting a signup it cannot finish.
   *
   * `WHATSAPP_SIGNUP_CONFIG_ID` is the Business Login configuration the client launches. It is the only
   * one of the three that reaches the browser, and it is not a secret: it names which permissions the
   * flow asks for, and Meta will only honour it for this app on an allow-listed domain.
   */
  WHATSAPP_APP_ID: z.string().min(1).max(64).optional(),
  WHATSAPP_APP_SECRET: z.string().min(1).max(256).optional(),
  WHATSAPP_SIGNUP_CONFIG_ID: z.string().min(1).max(64).optional(),
  /**
   * The token Meta echoes back during the webhook subscription handshake.
   *
   * Chosen by this deployment and configured in the App Dashboard, exactly like Instagram's. Without it
   * no WhatsApp adapter is bound, which answers every WhatsApp webhook with a 404 rather than accepting a
   * payload this deployment cannot verify.
   */
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).max(256).optional(),
  /**
   * Graph API version for the onboarding calls.
   *
   * A default of this deployment rather than a constant of the code: Meta deprecates a version after two
   * years, and moving with them must not need a release. Embedded Signup v2 and v3 die on 2026-10-15, so
   * the client flow is v4 regardless of what this says — this is the Graph version, not the flow's.
   */
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/u).max(16).default("v26.0"),

  /**
   * Embeddings, for the Knowledge Library's retrieval tester only (ADR-011, Issue #31).
   *
   * These must match the worker's. The tester exists to answer "would the assistant find this fact?", and
   * a tester configured differently from the process that actually retrieves answers a different question
   * — one an operator would act on. Absent is supported and honest: retrieval runs lexical-only, the
   * worker does the same with the same setting, and the tester says on screen which mode it is in.
   *
   * Nothing here is used to *write* embeddings. Indexing is the worker's, and the web app never chunks.
   */
  VOYAGE_API_KEY: z.string().min(1).max(512).optional(),
  /**
   * The reply model, for the simulation playground and the Style screen's test (Issues #30, #32).
   *
   * Optional, unlike the worker's, where a missing key means no draft can ever be produced and booting
   * without one would be booting broken. Here a missing key costs part of two read-only screens, and both
   * of them say so: the playground still runs retrieval and the deterministic policy, and the Style test
   * still shows the effective voice and the examples retrieval would pick. A deployment that never wants
   * the web app talking to a provider gets that by leaving this unset, which is a supported configuration
   * rather than a degraded one.
   *
   * Neither surface can send, whether this is set or not. The `ReplyModel` port has no transport, no
   * recipient and no tools, so a live run against a real provider still cannot reach a customer.
   */
  ANTHROPIC_API_KEY: z.string().min(1).max(512).optional(),
  AI_REPLY_MODEL: z.string().min(1).max(128).default("claude-opus-5"),
  AI_REPLY_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(8_192).default(4_096),
  AI_EMBEDDING_MODEL: z.string().min(1).max(128).default("voyage-3.5"),
  AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(4_096).default(1_024),
  AI_EMBEDDING_REVISION: z.string().min(1).max(32).default("v1"),

  /**
   * The platform's voice of last resort, used by the Style test only where a business has configured no
   * StyleProfile of its own.
   *
   * It must carry the same value as the worker's, for the same reason the embedding settings must: the
   * test exists to answer "how will the assistant sound?", and a fallback persona that differs from the
   * one the worker drafts with answers a different question.
   */
  AI_PERSONA: z
    .string()
    .min(1)
    .max(2_000)
    .default("You are the business's own assistant. Be warm, brief and concrete, and never invent facts."),

  /**
   * The values the published Terms and Privacy Policy need and the repository must not hold (#121).
   *
   * Configuration rather than text in `src/legal/`, for two reasons that both matter. The seller's
   * registered identity is the owner's own material and the standing direction is that it stays out of
   * public source; and several of these are not drafting choices at all but decisions the owner has not
   * made, some of which need a lawyer — governing law, the forum, the liability cap, the withdrawal
   * right, the retention periods. A value nobody has decided must not have a plausible default, because
   * a plausible default in a published legal document is a term somebody is held to. Every one of these
   * is therefore optional with no default, and `legal-content.ts` renders an unset value as a visible
   * gap rather than filling it in.
   */
  LEGAL_SELLER_NAME: z.string().min(1).max(200).optional(),
  LEGAL_SELLER_DISPLAY_NAME: z.string().min(1).max(200).optional(),
  LEGAL_SELLER_REGISTRATION: z.string().min(1).max(300).optional(),
  LEGAL_SELLER_ADDRESS: z.string().min(1).max(400).optional(),
  LEGAL_SELLER_JURISDICTION: z.string().min(1).max(100).optional(),
  LEGAL_SELLER_VAT: z.string().min(1).max(100).optional(),
  LEGAL_SUPPORT_EMAIL: z.email().optional(),
  LEGAL_PRIVACY_EMAIL: z.email().optional(),
  LEGAL_CONTACT_EMAIL: z.email().optional(),
  LEGAL_GOVERNING_LAW: z.string().min(1).max(300).optional(),
  LEGAL_FORUM: z.string().min(1).max(300).optional(),
  LEGAL_SUPERVISORY_AUTHORITY: z.string().min(1).max(300).optional(),
  LEGAL_LIABILITY_CAP: z.string().min(1).max(500).optional(),
  LEGAL_WITHDRAWAL: z.string().min(1).max(800).optional(),
  LEGAL_MINIMUM_AGE: z.string().min(1).max(40).optional(),
  LEGAL_RETENTION_ACCOUNT: z.string().min(1).max(300).optional(),
  LEGAL_RETENTION_BILLING: z.string().min(1).max(300).optional(),
  LEGAL_RETENTION_RECORDS: z.string().min(1).max(300).optional(),
  LEGAL_RETENTION_CONVERSATION: z.string().min(1).max(300).optional(),
  LEGAL_HOSTING_REGION: z.string().min(1).max(200).optional(),
  LEGAL_DPO: z.string().min(1).max(300).optional(),
  /** ISO `YYYY-MM-DD`. The date the published version takes effect. */
  LEGAL_EFFECTIVE_DATE: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  /** The integer in `legal_documents.version`. */
  LEGAL_VERSION: z.coerce.number().int().positive().optional(),
});

export type WebEnv = ReturnType<typeof loadWebEnv>;

export function loadWebEnv(source: EnvSource = process.env) {
  return parseEnv(webEnvSchema, source);
}
