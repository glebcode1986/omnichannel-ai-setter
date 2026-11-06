/**
 * The private pilot's invitation gate (#133).
 *
 * The cases worth writing are the ones where a gate stops being a gate without anything failing: an
 * allowlist that is empty, a mode spelled wrong, an entry that is not an address, an address that
 * differs from its invitation only in case or in a character that looks like `@`. Each of those has one
 * safe answer and one that quietly admits the public, and nothing downstream would report the second.
 */
import { describe, expect, it } from "vitest";

import { EMAIL_PROVIDER_ID } from "./sign-in-guard";
import {
  invitedAddresses,
  isInvited,
  LINK_REQUEST_ANSWER,
  normalizeAddress,
  signInAccess,
  signInGateVerdict,
  type InvitationConfig,
} from "./sign-in-invitations";

const invited = (list: string): InvitationConfig => ({ AUTH_SIGN_IN_ACCESS: "invite", AUTH_INVITE_ALLOWLIST: list });

describe("which mode a deployment is in", () => {
  it("registers anybody when nothing says otherwise, which is what #117 accepted", () => {
    expect(signInAccess({})).toBe("open");
    expect(signInAccess({ AUTH_SIGN_IN_ACCESS: undefined })).toBe("open");
    expect(signInAccess({ AUTH_SIGN_IN_ACCESS: "   " })).toBe("open");
    expect(signInAccess({ AUTH_SIGN_IN_ACCESS: "open" })).toBe("open");
    expect(signInAccess({ AUTH_SIGN_IN_ACCESS: "OPEN" })).toBe("open");
  });

  it("reads a value it does not recognise as the closed mode, not the open one", () => {
    // `env.ts` refuses to boot on these, so this is the second of two guards rather than the only one.
    // It matters which way an unreadable gate fails: `invitee` is one keystroke from `invite`, and the
    // version that reads it as `open` turns a private pilot into public registration in silence.
    expect(signInAccess({ AUTH_SIGN_IN_ACCESS: "invitee" })).toBe("invite");
    expect(signInAccess({ AUTH_SIGN_IN_ACCESS: "yes" })).toBe("invite");
    expect(signInAccess({ AUTH_SIGN_IN_ACCESS: "INVITE" })).toBe("invite");
  });
});

describe("who is invited", () => {
  it("admits everybody while the deployment is open, whatever the allowlist says", () => {
    expect(isInvited({ AUTH_INVITE_ALLOWLIST: "someone@example.com" }, "stranger@example.com")).toBe(true);
    expect(isInvited({}, "stranger@example.com")).toBe(true);
  });

  it("admits an invited address and refuses one that is not", () => {
    const config = invited("tester@example.com, other@example.com");

    expect(isInvited(config, "tester@example.com")).toBe(true);
    expect(isInvited(config, "other@example.com")).toBe(true);
    expect(isInvited(config, "stranger@example.com")).toBe(false);
  });

  /**
   * The trap this module exists for. A requirement read from a list that happens to be empty is a
   * requirement that enforces nothing — and the failure is invisible, because every other signal says
   * the deployment is configured. The second expectation is the control: the same mode with a real list
   * does admit somebody, so the first one is not passing because the gate refuses everything always.
   */
  it("invites nobody when the allowlist is empty, and still admits when it is not", () => {
    expect(isInvited(invited(""), "tester@example.com")).toBe(false);
    expect(isInvited({ AUTH_SIGN_IN_ACCESS: "invite" }, "tester@example.com")).toBe(false);
    expect(isInvited(invited("   ,  ;  "), "tester@example.com")).toBe(false);

    expect(isInvited(invited("tester@example.com"), "tester@example.com")).toBe(true);
  });

  it("refuses an address that is missing or blank rather than treating it as a match", () => {
    const config = invited("tester@example.com");

    expect(isInvited(config, undefined)).toBe(false);
    expect(isInvited(config, null)).toBe(false);
    expect(isInvited(config, "")).toBe(false);
    expect(isInvited(config, "   ")).toBe(false);
  });

  it("matches the spelling @auth/core hands it, not the spelling the operator typed", () => {
    // The library normalizes to NFKC and lower case before this gate ever sees the address, so an
    // allowlist that skipped either fold would hold entries no incoming address could equal.
    const config = invited("  Tester@Example.COM  ");

    expect(isInvited(config, "tester@example.com")).toBe(true);
    expect(isInvited(config, "TESTER@EXAMPLE.COM")).toBe(true);
    expect(normalizeAddress("tester＠example.com")).toBe("tester@example.com");
    expect(isInvited(invited("tester＠example.com"), "tester@example.com")).toBe(true);
  });

  it("reads a list separated by commas, semicolons or lines, the way one is actually pasted", () => {
    const list = "one@example.com,two@example.com; three@example.com\nfour@example.com\t five@example.com";

    expect(invitedAddresses({ AUTH_INVITE_ALLOWLIST: list }).size).toBe(5);
    for (const address of ["one", "two", "three", "four", "five"]) {
      expect(isInvited(invited(list), `${address}@example.com`)).toBe(true);
    }
  });

  it("lets a malformed entry fail closed instead of taking the rest of the list with it", () => {
    // An entry that is not an address matches no address: it costs that tester their invitation and
    // admits nobody extra. The last expectation is what stops a typo taking the whole pilot down.
    const config = invited("not-an-address, tester@example.com");

    expect(isInvited(config, "anyone@example.com")).toBe(false);
    expect(isInvited(config, "tester@example.com")).toBe(true);
  });

  it("treats an entry that looks like a wildcard as the literal text it is", () => {
    // The misunderstanding worth guarding: `*@example.com` reads like "everyone at this company" and
    // means nothing of the kind. Matching it as a pattern would hand a whole domain an invitation
    // nobody granted, so it matches one address — the one spelled exactly that way, which nobody has.
    const config = invited("*@example.com, *");

    expect(isInvited(config, "anyone@example.com")).toBe(false);
    expect(isInvited(config, "tester@example.com")).toBe(false);
    expect(isInvited(config, "*@example.com")).toBe(true);
  });
});

describe("the verdict the library is handed", () => {
  it("admits an invited address at both moments a link exists", () => {
    const config = invited("tester@example.com");

    expect(signInGateVerdict({ config, address: "tester@example.com", verificationRequest: true })).toBe(true);
    expect(signInGateVerdict({ config, address: "tester@example.com", verificationRequest: false })).toBe(true);
  });

  /**
   * The anti-enumeration property, stated as the value the library receives: asking for a link for an
   * address that was never invited must produce the answer a sent link produces. `false` would not —
   * it becomes `AccessDenied` and a different page, which is exactly the oracle a closed pilot must not
   * hand out.
   */
  it("answers a link request for a stranger with the same redirect a sent link produces", () => {
    const config = invited("tester@example.com");
    const verdict = signInGateVerdict({ config, address: "stranger@example.com", verificationRequest: true });

    expect(verdict).toBe(LINK_REQUEST_ANSWER);
    expect(verdict).not.toBe(false);
    // Every stranger gets the one answer: nothing in it is derived from the address.
    expect(signInGateVerdict({ config, address: "someone.else@example.org", verificationRequest: true })).toBe(verdict);
  });

  it("refuses a stranger who is spending a link, which is what makes revocation work", () => {
    // Taking an address out of the allowlist has to stop a link that is already in an inbox. The gate is
    // consulted again when the link is spent, and at that point there is nothing left to hide from
    // somebody who already holds it.
    expect(signInGateVerdict({ config: invited("tester@example.com"), address: "stranger@example.com", verificationRequest: false })).toBe(false);
  });

  it("admits everybody while the deployment is open", () => {
    expect(signInGateVerdict({ config: {}, address: "anyone@example.com", verificationRequest: true })).toBe(true);
    expect(signInGateVerdict({ config: {}, address: "anyone@example.com", verificationRequest: false })).toBe(true);
  });
});

describe("the answer a link request is given", () => {
  it("is spelled with the provider id the rest of the product uses", () => {
    // This module repeats the id rather than importing it from `sign-in-guard`, which reaches Redis.
    // The repetition is only safe while the two are the same string.
    expect(LINK_REQUEST_ANSWER).toContain(`provider=${EMAIL_PROVIDER_ID}`);
  });

  it("is a path with a query and no origin, so the redirect callback resolves it onto this deployment", () => {
    expect(LINK_REQUEST_ANSWER.startsWith("/")).toBe(true);
    expect(LINK_REQUEST_ANSWER).toBe("/api/auth/verify-request?provider=nodemailer&type=email");
  });
});
