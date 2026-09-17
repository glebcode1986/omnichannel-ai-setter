/**
 * Production composition of Instagram onboarding: real database, real cipher, real Meta transport.
 */
import { randomUUID } from "node:crypto";

import { createFetchHttpPort, type InstagramOAuthConfig } from "@omnichannel/channel-instagram";

import { createInstagramOnboardingStore } from "@omnichannel/db";

import { loadWebEnv } from "../env";
import { getCredentialCipher } from "./credential-cipher";
import { getDb } from "./db";
import type { OnboardingDependencies } from "./instagram-onboarding";
import type { InstagramRouteDependencies } from "./instagram-routes";
import { getLogger } from "./logger";
import { requireBusinessProfileContext } from "./request-context";

let oauth: InstagramOAuthConfig | undefined;

function getOAuthConfig(): InstagramOAuthConfig {
  if (oauth === undefined) {
    const env = loadWebEnv();
    oauth = {
      appId: env.INSTAGRAM_APP_ID,
      appSecret: env.INSTAGRAM_APP_SECRET,
      // From configuration only: deriving it from the request would let a forged Host header choose it.
      redirectUri: env.INSTAGRAM_REDIRECT_URI,
      http: createFetchHttpPort(),
    };
  }
  return oauth;
}

export function getOnboardingDependencies(): OnboardingDependencies {
  return {
    store: createInstagramOnboardingStore(getDb(), getCredentialCipher()),
    oauth: getOAuthConfig(),
    logger: getLogger(),
    now: () => new Date(),
    newId: randomUUID,
    humanAgentApproval: loadWebEnv().INSTAGRAM_HUMAN_AGENT_APPROVAL,
  };
}

export function getInstagramRouteDependencies(): InstagramRouteDependencies {
  return {
    onboarding: getOnboardingDependencies,
    authorize: requireBusinessProfileContext,
    logger: getLogger,
    connectedRedirectUrl: ({ workspaceId, businessProfileId, status }) => {
      // A same-origin relative path: nothing the provider sends can redirect the browser elsewhere.
      const target = workspaceId === undefined || businessProfileId === undefined ? "/channels" : `/workspaces/${workspaceId}/profiles/${businessProfileId}/channels`;
      return `${target}?instagram=${encodeURIComponent(status)}`;
    },
  };
}
