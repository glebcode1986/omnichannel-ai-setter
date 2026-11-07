/**
 * Production composition of Instagram onboarding: real database, real cipher, real Meta transport.
 *
 * Returns `undefined` when this deployment has no Instagram app it could finish a connection with, and
 * every caller treats that as "this deployment does not offer Instagram" — the same shape
 * `server/whatsapp.ts` has carried since Issue #19. Offering the connection anyway walks the operator out
 * to Meta, which refuses credentials it does not recognise and shows them a page of its own that says
 * nothing about this product and offers no way back.
 */
import { randomUUID } from "node:crypto";

import { createFetchHttpPort, type InstagramOAuthConfig } from "@omnichannel/channel-instagram";

import { createInstagramOnboardingStore } from "@omnichannel/db";

import { loadWebEnv, type WebEnv } from "../env";
import { getCredentialCipher } from "./credential-cipher";
import { getDb } from "./db";
import type { DisconnectDependencies, OnboardingDependencies } from "./instagram-onboarding";
import type { InstagramRouteDependencies } from "./instagram-routes";
import { getLogger } from "./logger";
import { isReservedHostname } from "./reserved-host";
import { requireBusinessProfileContext } from "./request-context";

let oauth: InstagramOAuthConfig | undefined;
/** Separate from `oauth`, because `undefined` is now an answer rather than "not read yet". */
let oauthRead = false;

function getOAuthConfig(): InstagramOAuthConfig | undefined {
  if (!oauthRead) {
    oauthRead = true;
    oauth = instagramOAuthFrom(loadWebEnv());
  }
  return oauth;
}

/**
 * Whether these three values describe an Instagram app a connection could actually complete against.
 *
 * A pure function of the environment, and exported, so the decision is testable without the process env
 * or a module cache: `instagramOAuthConfigured` is what the screens read, and a test of that alone cannot
 * tell a configuration being *judged* from one being waved through.
 */
export function instagramOAuthFrom(
  env: Pick<WebEnv, "INSTAGRAM_APP_ID" | "INSTAGRAM_APP_SECRET" | "INSTAGRAM_REDIRECT_URI">,
): InstagramOAuthConfig | undefined {
  const { INSTAGRAM_APP_ID: appId, INSTAGRAM_APP_SECRET: appSecret, INSTAGRAM_REDIRECT_URI: redirectUri } = env;
  // All three or none. An app id without a secret cannot complete the exchange, and either without a
  // redirect URI has nowhere to come back to, so two of the three is not most of a configuration.
  if (appId === undefined || appSecret === undefined || redirectUri === undefined) {
    return undefined;
  }
  // A callback that can never arrive is not a configuration either. The schema already proved this parses
  // as an HTTPS URL, so the constructor cannot throw here.
  if (isReservedHostname(new URL(redirectUri).hostname)) {
    return undefined;
  }
  return {
    appId,
    appSecret,
    // From configuration only: deriving it from the request would let a forged Host header choose it.
    redirectUri,
    http: createFetchHttpPort(),
  };
}

export function getOnboardingDependencies(): OnboardingDependencies | undefined {
  const config = getOAuthConfig();
  if (config === undefined) {
    return undefined;
  }
  return {
    store: createInstagramOnboardingStore(getDb(), getCredentialCipher()),
    oauth: config,
    logger: getLogger(),
    now: () => new Date(),
    newId: randomUUID,
    humanAgentApproval: loadWebEnv().INSTAGRAM_HUMAN_AGENT_APPROVAL,
  };
}

/**
 * Whether this deployment can connect Instagram at all.
 *
 * The setup and channel screens ask before they draw a button, through `offeredChannels`. Deliberately
 * only the configuration: no store, no cipher, no database, so a page can ask it without a query.
 */
export function instagramOAuthConfigured(): boolean {
  return getOAuthConfig() !== undefined;
}

/**
 * What detaching an account needs, and nothing more.
 *
 * Composed without the OAuth config on purpose: an account connected while this deployment had an
 * Instagram app must stay detachable after the app is gone, or removing the credentials would leave it
 * un-sendable, still holding an encrypted token, with no control that could remove it. The narrowed type
 * is what guarantees that rather than a comment.
 */
export function getDisconnectDependencies(): DisconnectDependencies {
  return {
    store: createInstagramOnboardingStore(getDb(), getCredentialCipher()),
    logger: getLogger(),
    now: () => new Date(),
  };
}

export function getInstagramRouteDependencies(): InstagramRouteDependencies {
  return {
    onboarding: getOnboardingDependencies,
    disconnect: getDisconnectDependencies,
    authorize: requireBusinessProfileContext,
    logger: getLogger,
    connectedRedirectUrl: ({ workspaceId, businessProfileId, status }) => {
      // A same-origin relative path: nothing the provider sends can redirect the browser elsewhere.
      const target = workspaceId === undefined || businessProfileId === undefined ? "/channels" : `/workspaces/${workspaceId}/profiles/${businessProfileId}/channels`;
      return `${target}?instagram=${encodeURIComponent(status)}`;
    },
  };
}
