/**
 * Whether this deployment has an Instagram app it could finish a connection against.
 *
 * Written because the first version of this change could not be tested: the decision lived inside a
 * memoized reader of the process environment, and the only test near it mocked the public
 * `instagramOAuthConfigured` outright. Deleting the reserved-host check left every test green — the
 * mutation survived, which is the exact shape of a backstop nothing reaches. So the decision is a pure
 * function of three values, and this reads it directly.
 *
 * What is *not* covered, stated rather than left to be found: that `getOAuthConfig` delegates here at
 * all. Replacing its body with a hard-coded config survives every test in this repository. Covering it
 * would mean driving `loadWebEnv()`'s read of the process environment — which validates the whole schema,
 * so the test would have to supply forty unrelated variables — and the memoization it guards is not
 * pointless either, because `loadWebEnv` re-parses on every call. Two lines of delegation, uncovered, in
 * exchange for that. Eleven of the twelve mutations tried against this change are caught; this is the one.
 */
import { describe, expect, it } from "vitest";

import { instagramOAuthFrom } from "./instagram";

const REAL = {
  INSTAGRAM_APP_ID: "1234567890123456",
  INSTAGRAM_APP_SECRET: "an-app-secret",
  INSTAGRAM_REDIRECT_URI: "https://dev.keepsaybot.online/api/channels/instagram/callback",
} as const;

describe("a configured deployment", () => {
  it("is configured, and carries the values through unchanged", () => {
    // The positive control. Without it every assertion below could pass on a function that always
    // refuses, which would take the channel away from everybody.
    const config = instagramOAuthFrom(REAL);

    expect(config).toBeDefined();
    expect(config?.appId).toBe(REAL.INSTAGRAM_APP_ID);
    expect(config?.appSecret).toBe(REAL.INSTAGRAM_APP_SECRET);
    expect(config?.redirectUri).toBe(REAL.INSTAGRAM_REDIRECT_URI);
  });

  it.each([
    ["https://localhost:3000/api/channels/instagram/callback", "what .env.example ships"],
    ["https://myapp.test/api/channels/instagram/callback", "a developer's own resolver"],
  ])("accepts %s — %s", (redirectUri) => {
    // The redirect is followed by the operator's browser, not fetched by Meta, so a local address is a
    // working configuration. Refusing these would break local development to tidy up a placeholder.
    expect(instagramOAuthFrom({ ...REAL, INSTAGRAM_REDIRECT_URI: redirectUri })).toBeDefined();
  });
});

describe("a deployment missing part of the app", () => {
  it.each(["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "INSTAGRAM_REDIRECT_URI"] as const)(
    "is not configured without %s",
    (absent) => {
      // Each one on its own, because two of the three is not most of a configuration: it is a button that
      // fails at the provider, which reads as this product failing.
      expect(instagramOAuthFrom({ ...REAL, [absent]: undefined })).toBeUndefined();
    },
  );

  it("is not configured with none of them", () => {
    expect(
      instagramOAuthFrom({ INSTAGRAM_APP_ID: undefined, INSTAGRAM_APP_SECRET: undefined, INSTAGRAM_REDIRECT_URI: undefined }),
    ).toBeUndefined();
  });
});

describe("a deployment whose callback can never arrive", () => {
  it.each([
    ["https://staging.invalid/api/channels/instagram/callback", "the placeholder a development host carries"],
    ["https://callback.example.com/x", "a documentation name nobody can own"],
    ["https://app.example/x", "the documentation TLD"],
  ])("is not configured with %s — %s", (redirectUri) => {
    // This is what the operator saw: valid-looking credentials, a `303` to Meta, and Meta's own "page
    // isn't available" with nothing of ours on it and no way back.
    expect(instagramOAuthFrom({ ...REAL, INSTAGRAM_REDIRECT_URI: redirectUri })).toBeUndefined();
  });

  it("judges the redirect URI and not the credentials beside it", () => {
    // Stated as a limit rather than left to be discovered: an app id is an opaque string here, no
    // documentation states a format for Meta's, so a plausible address with nonsense credentials is still
    // offered and still fails at the provider. The explicit way to say "no Instagram app" is to unset it.
    expect(instagramOAuthFrom({ ...REAL, INSTAGRAM_APP_ID: "staging-not-configured" })).toBeDefined();
  });
});
