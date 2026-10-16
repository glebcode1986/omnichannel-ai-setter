/**
 * Production composition of WhatsApp onboarding: real database, real cipher, real Meta transport.
 *
 * Returns `undefined` when the deployment has no WhatsApp app configured, and every caller treats that as
 * "this deployment does not offer WhatsApp". Starting a signup that cannot be finished would walk an
 * operator through Meta's whole flow — selecting a business, adding a number, accepting terms — and then
 * fail at the exchange, after Meta has already created assets on their account.
 */
import { randomUUID } from "node:crypto";

import { createFetchHttpPort, type WhatsAppSignupConfig } from "@omnichannel/channel-whatsapp";
import { createWhatsAppOnboardingStore } from "@omnichannel/db";

import { loadWebEnv } from "../env";
import { getCredentialCipher } from "./credential-cipher";
import { getDb } from "./db";
import { getLogger } from "./logger";
import { requireBusinessProfileContext } from "./request-context";
import type { WhatsAppOnboardingDependencies } from "./whatsapp-onboarding";
import type { WhatsAppRouteDependencies } from "./whatsapp-routes";

let signup: WhatsAppSignupConfig | undefined;

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

export function getWhatsAppRouteDependencies(): WhatsAppRouteDependencies {
  return {
    onboarding: getWhatsAppOnboardingDependencies,
    authorize: requireBusinessProfileContext,
    logger: getLogger,
  };
}
