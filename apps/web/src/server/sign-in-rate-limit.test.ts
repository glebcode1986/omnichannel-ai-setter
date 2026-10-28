/**
 * The sign-in limits, against the ways a limit is usually bypassed (#117).
 */
import { describe, expect, it } from "vitest";

import {
  checkSignInRateLimit,
  normalizeIdentifier,
  rateLimitKey,
  SIGN_IN_RATE_LIMITS,
  type AttemptCounter,
} from "./sign-in-rate-limit";

/** A counter with no clock: windows are not advanced, so every case is "within one window". */
function memoryCounter(): AttemptCounter & { readonly counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    increment: (key) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    },
  };
}

const CALLER = "198.51.100.7";

describe("asking for a sign-in link", () => {
  it("allows an ordinary person who mistypes and asks again", async () => {
    const counter = memoryCounter();

    for (let attempt = 0; attempt < SIGN_IN_RATE_LIMITS.REQUEST_LINK.perIdentifier!.limit; attempt += 1) {
      const decision = await checkSignInRateLimit(counter, {
        endpoint: "REQUEST_LINK",
        identifier: "someone@example.com",
        caller: CALLER,
      });
      expect(decision.allowed, `attempt ${String(attempt + 1)}`).toBe(true);
    }
  });

  it("refuses the attempt past the per-address limit", async () => {
    const counter = memoryCounter();
    const limit = SIGN_IN_RATE_LIMITS.REQUEST_LINK.perIdentifier!.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "someone@example.com", caller: CALLER });
    }

    expect(await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "someone@example.com", caller: CALLER })).toEqual({
      allowed: false,
      refusedBy: "IDENTIFIER",
    });
  });

  it("counts one address however it is capitalized or padded", async () => {
    // Otherwise the per-address limit is bypassed by pressing shift.
    const counter = memoryCounter();
    const limit = SIGN_IN_RATE_LIMITS.REQUEST_LINK.perIdentifier!.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "someone@example.com", caller: CALLER });
    }

    const padded = await checkSignInRateLimit(counter, {
      endpoint: "REQUEST_LINK",
      identifier: "  SomeOne@Example.COM ",
      caller: CALLER,
    });

    expect(padded).toEqual({ allowed: false, refusedBy: "IDENTIFIER" });
  });

  it("does not collapse addresses that may be different mailboxes", async () => {
    // `+tag` and dots are the same mailbox at some providers and not at others. Collapsing them would
    // refuse one person because another was noisy.
    const counter = memoryCounter();
    const limit = SIGN_IN_RATE_LIMITS.REQUEST_LINK.perIdentifier!.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "someone@example.com", caller: CALLER });
    }

    expect(
      await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "someone+tag@example.com", caller: `${CALLER}2` }),
    ).toEqual({ allowed: true });
  });

  it("limits one caller across many addresses", async () => {
    // The flood that the per-address rule cannot see: a different address every time.
    const counter = memoryCounter();
    const limit = SIGN_IN_RATE_LIMITS.REQUEST_LINK.perCaller.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      const decision = await checkSignInRateLimit(counter, {
        endpoint: "REQUEST_LINK",
        identifier: `victim-${String(attempt)}@example.com`,
        caller: CALLER,
      });
      expect(decision.allowed).toBe(true);
    }

    expect(await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "one-more@example.com", caller: CALLER })).toEqual({
      allowed: false,
      refusedBy: "CALLER",
    });
  });

  it("applies no caller rule at all when the deployment supplies no caller identity", async () => {
    // The first version of this counted an absent caller in one shared bucket, which is a global sign-in
    // outage after twenty attempts — a denial of service the product would be doing to itself. Nothing
    // here reads a client address, and a limiter keyed on a spoofable header reads as protection while
    // providing none, so the rule is simply absent until a deployment names a header it trusts.
    const counter = memoryCounter();
    const beyond = SIGN_IN_RATE_LIMITS.REQUEST_LINK.perCaller.limit + 5;
    for (let attempt = 0; attempt < beyond; attempt += 1) {
      const decision = await checkSignInRateLimit(counter, {
        endpoint: "REQUEST_LINK",
        identifier: `a-${String(attempt)}@example.com`,
        caller: undefined,
      });
      expect(decision.allowed, `attempt ${String(attempt + 1)}`).toBe(true);
    }
    // And nothing was counted under a caller key, so no bucket exists to overflow.
    expect([...counter.counts.keys()].some((key) => key.includes(":caller:"))).toBe(false);

    // A caller of whitespace is the same as none.
    expect(await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "b@example.com", caller: "   " })).toEqual({
      allowed: true,
    });
  });

  it("still refuses the per-address limit with no caller identity, because an address cannot be spoofed", async () => {
    const counter = memoryCounter();
    const limit = SIGN_IN_RATE_LIMITS.REQUEST_LINK.perIdentifier!.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "target@example.com" });
    }

    expect(await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "target@example.com" })).toEqual({
      allowed: false,
      refusedBy: "IDENTIFIER",
    });
  });

  it("keeps counting the address even when the caller is already refused", async () => {
    // Otherwise a flood resets its own per-address counters by alternating callers.
    const counter = memoryCounter();
    const callerLimit = SIGN_IN_RATE_LIMITS.REQUEST_LINK.perCaller.limit;
    for (let attempt = 0; attempt <= callerLimit + 2; attempt += 1) {
      await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "target@example.com", caller: CALLER });
    }

    const identifierKey = rateLimitKey("REQUEST_LINK", "id", "target@example.com");
    expect(counter.counts.get(identifierKey)).toBe(callerLimit + 3);
  });

  it("refuses by address rather than by caller when both are over, so the log names the narrower cause", async () => {
    const counter = memoryCounter();
    for (let attempt = 0; attempt <= SIGN_IN_RATE_LIMITS.REQUEST_LINK.perCaller.limit + 2; attempt += 1) {
      await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "target@example.com", caller: CALLER });
    }

    expect(await checkSignInRateLimit(counter, { endpoint: "REQUEST_LINK", identifier: "target@example.com", caller: CALLER })).toEqual({
      allowed: false,
      refusedBy: "IDENTIFIER",
    });
  });
});

describe("verifying a sign-in link", () => {
  it("limits attempts by caller", async () => {
    const counter = memoryCounter();
    const limit = SIGN_IN_RATE_LIMITS.VERIFY_LINK.perCaller.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      expect((await checkSignInRateLimit(counter, { endpoint: "VERIFY_LINK", caller: CALLER })).allowed).toBe(true);
    }

    expect(await checkSignInRateLimit(counter, { endpoint: "VERIFY_LINK", caller: CALLER })).toEqual({
      allowed: false,
      refusedBy: "CALLER",
    });
  });

  it("has no per-address rule, so one person's link cannot be locked out by a flood at it", async () => {
    expect(SIGN_IN_RATE_LIMITS.VERIFY_LINK.perIdentifier).toBeUndefined();

    const counter = memoryCounter();
    await checkSignInRateLimit(counter, { endpoint: "VERIFY_LINK", identifier: "someone@example.com", caller: CALLER });

    expect([...counter.counts.keys()].some((key) => key.includes(":id:"))).toBe(false);
  });
});

describe("the key an attempt is counted under", () => {
  it("never contains the address", () => {
    const key = rateLimitKey("REQUEST_LINK", "id", "someone@example.com");

    // A counter store is not a place to keep a list of who tried to sign in, and a dump of one should not
    // be a customer list.
    expect(key).not.toContain("someone");
    expect(key).not.toContain("example.com");
    expect(key).not.toContain("@");
  });

  it("separates the two endpoints and the two scopes", () => {
    const value = "someone@example.com";

    expect(rateLimitKey("REQUEST_LINK", "id", value)).not.toBe(rateLimitKey("VERIFY_LINK", "id", value));
    expect(rateLimitKey("REQUEST_LINK", "id", value)).not.toBe(rateLimitKey("REQUEST_LINK", "caller", value));
  });

  it("is stable for one input, or no window would ever accumulate", () => {
    expect(rateLimitKey("REQUEST_LINK", "id", normalizeIdentifier(" A@B.com "))).toBe(rateLimitKey("REQUEST_LINK", "id", "a@b.com"));
  });
});
