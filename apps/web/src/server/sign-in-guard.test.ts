/**
 * The limit in front of the sign-in endpoints (#117).
 *
 * Two properties matter more than the arithmetic, which `sign-in-rate-limit.test.ts` already covers. The
 * guard must not **break the request it protects** — it reads the posted address, and the handler behind it
 * reads the same body. And a refusal must not become an **enumeration oracle**: it has to look the same
 * for an address with an account and one without, which it achieves by consulting no table at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const counts = new Map<string, number>();
const warnings: { event: string; fields: unknown }[] = [];

vi.mock("./sign-in-counter", () => ({
  getSignInCounter: () => ({
    increment: (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    },
  }),
}));
vi.mock("./logger", () => ({
  getLogger: () => ({
    warn: (event: string, fields: unknown) => {
      warnings.push({ event, fields });
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const { EMAIL_PROVIDER_ID, LINK_SENT_PATH, guardSignInRequest, identifierFrom, signInEndpointFor } = await import("./sign-in-guard");
const { SIGN_IN_RATE_LIMITS } = await import("./sign-in-rate-limit");

const ORIGIN = "https://app.example";

/** A request shaped like the one Auth.js's email sign-in receives. */
function linkRequest(email: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/signin/${EMAIL_PROVIDER_ID}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ email, callbackUrl: `${ORIGIN}/workspaces` }).toString(),
  });
}

beforeEach(() => {
  counts.clear();
  warnings.length = 0;
});

describe("which requests are subject to a limit", () => {
  it.each([
    ["POST", `/api/auth/signin/${EMAIL_PROVIDER_ID}`, "REQUEST_LINK"],
    ["GET", `/api/auth/callback/${EMAIL_PROVIDER_ID}`, "VERIFY_LINK"],
  ])("limits %s %s", (method, path, endpoint) => {
    expect(signInEndpointFor(method, path)).toBe(endpoint);
  });

  it.each([
    ["the Google hand-off, which Google rate-limits itself", "POST", "/api/auth/signin/google"],
    ["the Google callback", "GET", "/api/auth/callback/google"],
    ["a session read", "GET", "/api/auth/session"],
    ["the CSRF token", "GET", "/api/auth/csrf"],
    ["a GET of the email sign-in, which sends nothing", "GET", `/api/auth/signin/${EMAIL_PROVIDER_ID}`],
  ])("does not limit %s", (_case, method, path) => {
    expect(signInEndpointFor(method, path)).toBeUndefined();
  });
});

describe("reading the address a request asked for", () => {
  it("does not consume the body the handler still needs", async () => {
    // A guard that broke the request it was protecting would be worse than no guard.
    const request = linkRequest("someone@example.com");

    expect(await identifierFrom(request as never)).toBe("someone@example.com");

    const stillReadable = await request.formData();
    expect(stillReadable.get("email")).toBe("someone@example.com");
  });

  it("finds no address in a body that is not a form", async () => {
    const request = new Request(`${ORIGIN}/api/auth/signin/${EMAIL_PROVIDER_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "someone@example.com" }),
    });

    expect(await identifierFrom(request as never)).toBeUndefined();
  });

  it("finds no address in an unparseable form body", async () => {
    const request = new Request(`${ORIGIN}/api/auth/signin/${EMAIL_PROVIDER_ID}`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=nope" },
      body: "not a multipart body",
    });

    expect(await identifierFrom(request as never)).toBeUndefined();
  });
});

describe("what a refused request receives", () => {
  const exhaust = async (email: string) => {
    for (let attempt = 0; attempt < SIGN_IN_RATE_LIMITS.REQUEST_LINK.perIdentifier!.limit; attempt += 1) {
      await guardSignInRequest(linkRequest(email) as never, { origin: ORIGIN });
    }
  };

  it("lets an ordinary request through untouched", async () => {
    expect(await guardSignInRequest(linkRequest("someone@example.com") as never, { origin: ORIGIN })).toEqual({});
  });

  it("answers a refused link request exactly as a successful one is answered", async () => {
    await exhaust("someone@example.com");

    const { refusal } = await guardSignInRequest(linkRequest("someone@example.com") as never, { origin: ORIGIN });

    // The same page, the same status, no distinguishing message: a 429 on the sign-in form is a signal to
    // script against, and the person who genuinely asked five times is better served by the calm page.
    expect(refusal?.status).toBe(302);
    expect(refusal?.headers.get("Location")).toBe(`${ORIGIN}${LINK_SENT_PATH}?provider=${EMAIL_PROVIDER_ID}&type=email`);
  });

  it("refuses an address with an account and one without identically", async () => {
    // The enumeration property, and it is structural: the counter is keyed on the address and consults no
    // table, so there is nothing for the response to differ about. Neither of these addresses exists in
    // any database this test has — which is the point: the guard never asked.
    await exhaust("customer@example.com");
    await exhaust("nobody-has-this@example.com");

    const first = await guardSignInRequest(linkRequest("customer@example.com") as never, { origin: ORIGIN });
    const second = await guardSignInRequest(linkRequest("nobody-has-this@example.com") as never, { origin: ORIGIN });

    expect(first.refusal?.status).toBe(second.refusal?.status);
    expect(first.refusal?.headers.get("Location")).toBe(second.refusal?.headers.get("Location"));
  });

  it("logs a refusal without the address it refused", async () => {
    // This is the one place that knows the address, and a log of refused sign-ins would be a list of
    // addresses somebody is interested in.
    await exhaust("someone@example.com");
    await guardSignInRequest(linkRequest("someone@example.com") as never, { origin: ORIGIN });

    expect(warnings.map((entry) => entry.event)).toContain("signin.rate_limited");
    expect(JSON.stringify(warnings)).not.toContain("someone@example.com");
    expect(JSON.stringify(warnings)).not.toContain("someone");
  });

  it("applies no caller rule when the deployment names no trusted header", async () => {
    for (let attempt = 0; attempt < SIGN_IN_RATE_LIMITS.REQUEST_LINK.perCaller.limit + 3; attempt += 1) {
      const decision = await guardSignInRequest(
        linkRequest(`person-${String(attempt)}@example.com`, { "x-forwarded-for": "198.51.100.9" }) as never,
        { origin: ORIGIN },
      );
      expect(decision.refusal, `attempt ${String(attempt + 1)}`).toBeUndefined();
    }
  });

  it("applies the caller rule once a deployment names the header its proxy sets", async () => {
    const options = { origin: ORIGIN, trustedClientIpHeader: "x-forwarded-for" };
    for (let attempt = 0; attempt < SIGN_IN_RATE_LIMITS.REQUEST_LINK.perCaller.limit; attempt += 1) {
      await guardSignInRequest(linkRequest(`person-${String(attempt)}@example.com`, { "x-forwarded-for": "198.51.100.9" }) as never, options);
    }

    const { refusal } = await guardSignInRequest(
      linkRequest("one-more@example.com", { "x-forwarded-for": "198.51.100.9, 10.0.0.1" }) as never,
      options,
    );

    expect(refusal?.status).toBe(302);
  });

  it("sends a refused verification to the page that explains a spent link", async () => {
    const options = { origin: ORIGIN, trustedClientIpHeader: "x-forwarded-for" };
    const attempt = () =>
      guardSignInRequest(
        new Request(`${ORIGIN}/api/auth/callback/${EMAIL_PROVIDER_ID}?token=x&email=a%40b.test`, {
          headers: { "x-forwarded-for": "203.0.113.5" },
        }) as never,
        options,
      );

    for (let index = 0; index < SIGN_IN_RATE_LIMITS.VERIFY_LINK.perCaller.limit; index += 1) {
      expect((await attempt()).refusal, `attempt ${String(index + 1)}`).toBeUndefined();
    }
    const { refusal } = await attempt();

    // Asserted unconditionally. An `if (refusal !== undefined)` around this would pass whether or not the
    // limit works, which is the shape of a test that proves nothing.
    expect(refusal?.status).toBe(302);
    expect(refusal?.headers.get("Location")).toBe(`${ORIGIN}/sign-in?error=Verification`);
  });
});
