/**
 * Production composition of WhatsApp onboarding: real database, real cipher, real Meta transport.
 *
 * `getWhatsAppOnboardingDependencies` returns `undefined` when the deployment has no WhatsApp app
 * configured, and the connect and complete routes treat that as "this deployment does not offer
 * WhatsApp". Starting a signup that cannot be finished would walk an operator through Meta's whole flow —
 * selecting a business, adding a number, accepting terms — and then fail at the exchange, after Meta has
 * already created assets on their account.
 *
 * Disconnect is composed separately and has no such `undefined`, because detaching an account needs no
 * app of ours. See `getWhatsAppDisconnectDependencies`.
 */
import { randomUUID } from "node:crypto";

import { createFetchHttpPort, type WhatsAppGraphConfig, type WhatsAppSignupConfig } from "@omnichannel/channel-whatsapp";
import { createWhatsAppOnboardingStore } from "@omnichannel/db";

import { loadWebEnv } from "../env";
import { getCredentialCipher } from "./credential-cipher";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { requireBusinessProfileContext } from "./request-context";
import type { DisconnectDependencies, WhatsAppOnboardingDependencies } from "./whatsapp-onboarding";
import type { WhatsAppRouteDependencies } from "./whatsapp-routes";

let signup: WhatsAppSignupConfig | undefined;

/**
 * Where Graph is and how to reach it, carrying none of the app's credentials.
 *
 * Always available, because nothing in it is configuration a deployment can be missing: the graph version
 * has a default and the transport is `fetch`. This is what lets disconnect keep its provider unsubscribe
 * on a deployment that has no WhatsApp app configured at all.
 */
function getGraphConfig(): WhatsAppGraphConfig {
  return { graphVersion: loadWebEnv().WHATSAPP_GRAPH_VERSION, http: createFetchHttpPort() };
}

function getSignupConfig(): WhatsAppSignupConfig | undefined {
  if (signup === undefined) {
    const env = loadWebEnv();
    if (env.WHATSAPP_APP_ID === undefined || env.WHATSAPP_APP_SECRET === undefined || env.WHATSAPP_SIGNUP_CONFIG_ID === undefined) {
      return undefined;
    }
    signup = {
      appId: env.WHATSAPP_APP_ID,
      appSecret: env.WHATSAPP_APP_SECRET,
      configId: env.WHATSAPP_SIGNUP_CONFIG_ID,
      graphVersion: env.WHATSAPP_GRAPH_VERSION,
      http: createFetchHttpPort(),
    };
  }
  return signup;
}

export function getWhatsAppOnboardingDependencies(): WhatsAppOnboardingDependencies | undefined {
  const config = getSignupConfig();
  if (config === undefined) {
    return undefined;
  }
  return {
    store: createWhatsAppOnboardingStore(getDb(), getCredentialCipher()),
    signup: config,
    logger: getLogger(),
    now: () => new Date(),
    newId: randomUUID,
  };
}

/**
 * What detaching an account needs, and nothing more.
 *
 * Composed without the signup configuration on purpose: an account connected while this deployment had a
 * WhatsApp app must stay detachable after that configuration is gone, or removing it would leave the
 * account un-sendable, still holding an encrypted token, with no control that could remove it — this API
 * route being the only control there is. The narrowed type is what guarantees that rather than a comment.
 */
export function getWhatsAppDisconnectDependencies(): DisconnectDependencies {
  return {
    store: createWhatsAppOnboardingStore(getDb(), getCredentialCipher()),
    graph: getGraphConfig(),
    logger: getLogger(),
    now: () => new Date(),
  };
}

/**
 * Whether this deployment can connect WhatsApp at all.
 *
 * The setup screen asks before it draws a button. A deployment with no WhatsApp app answers every
 * connect with `503 not_configured`, and a button that does that reads as our failure rather than as a
 * missing app — so the card says the installation cannot offer the channel instead of offering it.
 * Deliberately only the configuration: no store, no cipher, no database.
 */
export function whatsAppSignupConfigured(): boolean {
  return getSignupConfig() !== undefined;
}

export function getWhatsAppRouteDependencies(): WhatsAppRouteDependencies {
  return {
    onboarding: getWhatsAppOnboardingDependencies,
    disconnect: getWhatsAppDisconnectDependencies,
    authorize: requireBusinessProfileContext,
    logger: getLogger,
  };
}
