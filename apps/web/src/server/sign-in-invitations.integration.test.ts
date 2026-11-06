/**
 * The invitation gate as the library actually applies it, against a real database (#133).
 *
 * `sign-in-invitations.test.ts` proves the decision. This file proves the **wiring**, which is the half
 * that has gone wrong here before: a gate can be correct, exported, tested and never reached, and in this
 * flow there are two entry points — the HTTP route and the in-process `signIn()` the product's own form
 * uses — so a guard attached to either one alone guards every caller except the other. The gate under
 * test is in the `signIn` callback, the one point both share, and the way to show it is reached is to run
 * the real `handlers` and look at what the database and the transport were asked to do.
 *
 * **What is mocked and why.** The transport, because this is not a deliverability test and a real SMTP
 * connection would make the two cases differ by something other than the gate; and `getDb`, because the
 * composition root reads a connection string this suite does not own. Everything else — `auth.ts`, its
 * providers, `@auth/core`, the Prisma adapter, the schema — is the real thing.
 *
 * The rate limit is **not** in this path: `handlers` is called directly, as `route.ts` calls it after its
 * own guard, which `sign-in-guard.test.ts` covers and which needs Redis. Keeping them apart is what lets
 * this file say that a refusal here is the invitation's doing and nothing else's.
 */
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LINK_REQUEST_ANSWER } from "./sign-in-invitations";
import { createMigratedTestDatabase, databaseTestsEnabled, type TestDatabase } from "./testing/database";

let database: TestDatabase;

/** Every address the transport was asked to write to, and the link it was handed. */
const sent: { readonly identifier: string; readonly url: string }[] = [];

vi.mock("./db", () => ({ getDb: () => database.db }));
vi.mock("./sign-in-mailer", () => ({
  smtpTransport: () => ({}),
  sendSignInLink: (_transport: unknown, options: { readonly identifier: string; readonly url: string }) => {
    sent.push({ identifier: options.identifier, url: options.url });
    return Promise.resolve();
  },
}));

const { handlers } = await import("../auth");

const ORIGIN = "https://pilot.example.test";
const INVITED = "invited@example.test";
const STRANGER = "stranger@example.test";

const baseEnv: Record<string, string> = {
  DATABASE_URL: "postgresql://user:fake-password@localhost:5432/omnichannel",
  AUTH_SECRET: "fake-auth-secret-for-tests-0123456789",
  AUTH_URL: ORIGIN,
  AUTH_EMAIL_SERVER: "smtps://resend:fake-password@smtp.example.test:2465",
  AUTH_EMAIL_FROM: "KeepSayBot <no-reply@pilot.example.test>",
  REDIS_URL: "redis://127.0.0.1:6379",
  CHANNEL_CREDENTIAL_KEY_ID: "test-key-1",
  CHANNEL_CREDENTIAL_KEY: Buffer.alloc(32, 3).toString("base64"),
  INSTAGRAM_APP_ID: "1234567890",
  INSTAGRAM_APP_SECRET: "fake-instagram-app-secret",
  INSTAGRAM_REDIRECT_URI: "https://pilot.example.test/api/channels/instagram/callback",
};

/** Puts the deployment in one configuration for the next request. Read per request, never cached. */
function configure(overrides: Record<string, string | undefined> = {}): void {
  for (const [key, value] of Object.entries({ ...baseEnv, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

/** The cookies a response sets, in the `name=value` form a following request sends back. */
function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair !== "" && !pair.endsWith("="))
    .join("; ");
}

/** A CSRF token and the cookie that validates it, obtained the way a browser obtains them. */
async function csrf(): Promise<{ readonly token: string; readonly cookie: string }> {
  const response = await handlers.GET(new NextRequest(`${ORIGIN}/api/auth/csrf`));
  const body = (await response.json()) as { csrfToken: string };
  return { token: body.csrfToken, cookie: cookiesFrom(response) };
}

/** Asks for a sign-in link exactly as the HTML form does. */
async function requestLink(email: string): Promise<Response> {
  const { token, cookie } = await csrf();
  const body = new URLSearchParams({ email, csrfToken: token, callbackUrl: `${ORIGIN}/workspaces` });
  return handlers.POST(
    new NextRequest(`${ORIGIN}/api/auth/signin/nodemailer`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body,
    }),
  );
}

/** The path and query a redirect points at, which is what two answers are compared by. */
function target(response: Response): string {
  const location = response.headers.get("location") ?? "";
  const url = new URL(location, ORIGIN);
  return `${url.pathname}${url.search}`;
}

describe.skipIf(!databaseTestsEnabled())("the invitation gate, as the library applies it", () => {
  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  }, 240_000);

  afterAll(async () => {
    await database?.dispose();
  });

  beforeEach(async () => {
    sent.length = 0;
    await database.db.verificationToken.deleteMany({});
    await database.db.session.deleteMany({});
    await database.db.user.deleteMany({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends a link to an invited address and writes exactly one token for it", async () => {
    configure({ AUTH_SIGN_IN_ACCESS: "invite", AUTH_INVITE_ALLOWLIST: INVITED });

    const response = await requestLink(INVITED);

    expect(target(response)).toBe(LINK_REQUEST_ANSWER);
    expect(sent.map((message) => message.identifier)).toEqual([INVITED]);
    expect(await database.db.verificationToken.count({ where: { identifier: INVITED } })).toBe(1);
  }, 240_000);

  /**
   * The property the pilot rests on. A stranger who guesses at an invited colleague's address must not
   * be able to tell that it was invited, so the response is compared field by field against the one a
   * sent link produces — and the comparison is only worth anything because the expectation above pins
   * that answer to a concrete, non-empty value. What differs is everything the caller cannot see: no
   * mail, and no row.
   */
  it("answers an uninvited address exactly as it answers an invited one, and sends nothing", async () => {
    configure({ AUTH_SIGN_IN_ACCESS: "invite", AUTH_INVITE_ALLOWLIST: INVITED });

    const admitted = await requestLink(INVITED);
    const refused = await requestLink(STRANGER);

    expect(target(refused)).toBe(target(admitted));
    expect(target(refused)).toBe(LINK_REQUEST_ANSWER);
    expect(refused.status).toBe(admitted.status);
    expect(sent.map((message) => message.identifier)).toEqual([INVITED]);
    expect(await database.db.verificationToken.count({ where: { identifier: STRANGER } })).toBe(0);
    expect(await database.db.user.count({ where: { email: STRANGER } })).toBe(0);
  }, 240_000);

  it("sends to that same stranger the moment the deployment is open, which is what makes the refusal the gate's", async () => {
    // The control. Without it, "nothing was sent" could equally mean the transport was never wired up in
    // this suite at all, and the case above would pass against a product that can send no mail to anyone.
    configure({ AUTH_SIGN_IN_ACCESS: undefined, AUTH_INVITE_ALLOWLIST: undefined });

    const response = await requestLink(STRANGER);

    expect(target(response)).toBe(LINK_REQUEST_ANSWER);
    expect(sent.map((message) => message.identifier)).toEqual([STRANGER]);
  }, 240_000);

  it("invites nobody when the allowlist is empty, rather than everybody", async () => {
    // An empty value reaches `loadWebEnv` as absent, which is the shape a cleared variable actually has.
    configure({ AUTH_SIGN_IN_ACCESS: "invite", AUTH_INVITE_ALLOWLIST: "" });

    const response = await requestLink(INVITED);

    expect(target(response)).toBe(LINK_REQUEST_ANSWER);
    expect(sent).toEqual([]);
    expect(await database.db.verificationToken.count({})).toBe(0);
  }, 240_000);

  it("lets an invited link be spent, and signs the person in", async () => {
    configure({ AUTH_SIGN_IN_ACCESS: "invite", AUTH_INVITE_ALLOWLIST: INVITED });
    await requestLink(INVITED);
    const link = sent[0]?.url ?? "";

    const response = await handlers.GET(new NextRequest(link));

    expect(response.status).toBe(302);
    expect(target(response)).toBe("/workspaces");
    expect(await database.db.session.count()).toBe(1);
    expect(await database.db.user.count({ where: { email: INVITED } })).toBe(1);
  }, 240_000);

  /**
   * Revocation, which is the only reason the gate is consulted a second time. A link already sitting in
   * an inbox is a credential that nothing else can take back: the allowlist is the taking back, and if
   * the gate only ran when a link was *asked for*, removing an address would do nothing to the link it
   * already has.
   */
  it("refuses a link that was issued before the address was taken off the list", async () => {
    configure({ AUTH_SIGN_IN_ACCESS: "invite", AUTH_INVITE_ALLOWLIST: INVITED });
    await requestLink(INVITED);
    const link = sent[0]?.url ?? "";

    configure({ AUTH_SIGN_IN_ACCESS: "invite", AUTH_INVITE_ALLOWLIST: "someone.else@example.test" });
    const response = await handlers.GET(new NextRequest(link));

    expect(target(response)).not.toBe("/workspaces");
    expect(target(response)).toContain("error=AccessDenied");
    expect(await database.db.session.count()).toBe(0);
    expect(await database.db.user.count({ where: { email: INVITED } })).toBe(0);
  }, 240_000);
});
