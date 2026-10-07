// @vitest-environment jsdom
/**
 * The console's panes (#59, ADMIN_OPERATIONS.md).
 *
 * The cases worth writing are the ones where an internal screen would mislead an operator about a
 * customer or about the platform: a control offered to somebody the store will refuse, a pause whose
 * owner is not shown, a "retry" that looks like a resend, and a customer's words rendered without a
 * session.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KillSwitchRow, ReconciliationRow, SupportSessionRow, SupportSnapshot } from "@omnichannel/db";
import { noSupportScope, PLAN_FEATURES, type PlanFeature, type SupportScope } from "@omnichannel/domain";

import { KillSwitches } from "./kill-switches";
import { PlatformAuditTable } from "./platform-audit-table";
import { ReconciliationQueue } from "./reconciliation-queue";
import { SupportAccess } from "./support-access";
import { WorkspaceSummary } from "./workspace-summary";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const ru = createTranslator("ru");
const text = (key: MessageKey) => catalogues.en[key];
const NOW = new Date("2026-10-08T12:00:00.000Z");

afterEach(cleanup);

const snapshot = (overrides: Partial<SupportSnapshot> = {}): SupportSnapshot => ({
  workspaceId: "ws-1",
  name: "Acme",
  createdAt: NOW,
  members: 3,
  profiles: [{ businessProfileId: "bp-1", name: "Main", status: "ACTIVE", channelAccounts: 1 }],
  channels: [
    {
      channelAccountId: "ca-1",
      businessProfileId: "bp-1",
      channel: "INSTAGRAM",
      status: "CONNECTED",
      displayName: "acme",
      externalAccountId: "ig-1",
      connectedAt: NOW,
    },
  ],
  entitlement: {
    workspaceId: "ws-1",
    state: "ACTIVE",
    planCode: "growth",
    planVersion: 2,
    subscribed: true,
    paidWorkAllowed: true,
    // Built from the domain's own list rather than spelled out, so a new plan feature does not make this
    // fixture a compile error in a file that has nothing to do with features.
    features: Object.fromEntries(PLAN_FEATURES.map((feature) => [feature, true])) as Record<PlanFeature, boolean>,
    limits: {},
    quotas: {},
    resolvedAt: NOW,
  },
  usage: { periodStartsAt: NOW, periodEndsAt: NOW, cycleOpened: false, counters: {} },
  lastInboundAt: NOW,
  lastOutboundAt: null,
  pendingReconciliations: 0,
  ...overrides,
});

describe("the workspace summary", () => {
  it("says whether paid work is allowed, which is the fact that decides everything else", () => {
    render(<WorkspaceSummary t={t} snapshot={snapshot()} />);
    expect(global.document.querySelector('[data-summary="paid-work"]')?.getAttribute("data-allowed")).toBe("true");

    cleanup();
    render(<WorkspaceSummary t={t} snapshot={snapshot({ entitlement: { ...snapshot().entitlement, paidWorkAllowed: false } })} />);
    expect(global.document.querySelector('[data-summary="paid-work"]')?.textContent).toBe(text("admin.paidWorkStopped"));
  });

  it("distinguishes a pause an operator pulled from one the system raised", () => {
    render(<WorkspaceSummary t={t} snapshot={snapshot({ pause: { scope: "WORKSPACE", reason: "OPERATOR", since: NOW, until: null, byOperator: true } })} />);
    expect(global.document.querySelector('[data-summary="pause"]')?.textContent).toContain(text("admin.byOperator"));

    cleanup();
    render(<WorkspaceSummary t={t} snapshot={snapshot({ pause: { scope: "GLOBAL", reason: "BACKLOG", since: NOW, until: null, byOperator: false } })} />);
    expect(global.document.querySelector('[data-summary="pause"]')?.textContent).toContain(text("admin.bySystem"));
  });

  it("says that reading it opened no usage cycle", () => {
    // The panel is documented as read-only, and this is the attribute that says it really was.
    render(<WorkspaceSummary t={t} snapshot={snapshot()} />);

    expect(global.document.querySelector('[data-summary="usage-period"]')?.getAttribute("data-cycle-opened")).toBe("false");
  });

  it("shows no credential, no capability blob and no token", () => {
    render(<WorkspaceSummary t={t} snapshot={snapshot()} />);
    const rendered = global.document.body.textContent ?? "";

    expect(rendered).not.toContain("credential");
    expect(rendered).not.toContain("accessToken");
    // The provider's own account id is shown on purpose: it is not a secret, and it is what a provider's
    // support desk asks for.
    expect(global.document.querySelector('[data-channel-account="ca-1"]')?.textContent).toContain("ig-1");
  });

  it("names the channel and its status through the catalogue, in both languages", () => {
    render(<WorkspaceSummary t={ru} snapshot={snapshot()} />);

    const line = global.document.querySelector('[data-channel-account="ca-1"]')?.textContent ?? "";
    expect(line).toContain(catalogues.ru["accountStatus.CONNECTED"]);
    expect(line).not.toContain("CONNECTED");
  });
});

describe("support access", () => {
  const session = (overrides: Partial<SupportSessionRow> = {}): SupportSessionRow => ({
    sessionId: "sa-1",
    actorName: "Dana",
    actorRole: "SUPPORT",
    businessProfileId: null,
    scopes: ["CONVERSATION_CONTENT"],
    reason: "ticket 4411",
    ticketRef: "4411",
    breakGlass: false,
    startedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    revokedAt: null,
    live: true,
    ...overrides,
  });
  const granted: SupportScope = { workspaceId: "ws-1", granted: ["CONVERSATION_CONTENT"], breakGlass: false, sessionId: "sa-1" };

  it("offers no controls at all to a role that cannot open a session", () => {
    render(
      <SupportAccess
        t={t}
        workspaceId="ws-1"
        sessions={[session()]}
        scope={noSupportScope("ws-1", "NO_SESSION")}
        canOpen={false}
        canBreakGlass={false}
        actions={{ open: vi.fn(), revoke: vi.fn() }}
      />,
    );

    // Absent rather than disabled, and the store refuses them regardless of what this renders.
    expect(global.document.querySelector('[data-admin="open-session"]')).toBeNull();
    expect(global.document.querySelector('[data-admin="revoke-session"]')).toBeNull();
    expect(global.document.querySelector('[data-admin="cannot-open-session"]')?.textContent).toBe(text("admin.notYourRole"));
  });

  it("offers break-glass only to a role that holds it, and never pre-ticked", () => {
    render(
      <SupportAccess
        t={t}
        workspaceId="ws-1"
        sessions={[]}
        scope={noSupportScope("ws-1", "NO_SESSION")}
        canOpen
        canBreakGlass={false}
        actions={{ open: vi.fn(), revoke: vi.fn() }}
      />,
    );
    expect(global.document.querySelector('input[name="breakGlass"]')).toBeNull();

    cleanup();
    render(
      <SupportAccess
        t={t}
        workspaceId="ws-1"
        sessions={[]}
        scope={noSupportScope("ws-1", "NO_SESSION")}
        canOpen
        canBreakGlass
        actions={{ open: vi.fn(), revoke: vi.fn() }}
      />,
    );
    const box = global.document.querySelector<HTMLInputElement>('input[name="breakGlass"]');
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(false);
    // The reason is required: a session nobody can explain is one nobody dares revoke.
    expect(global.document.querySelector<HTMLInputElement>('input[name="reason"]')?.required).toBe(true);
  });

  it("says whether the operator's own session covers this workspace", () => {
    render(
      <SupportAccess t={t} workspaceId="ws-1" sessions={[]} scope={granted} canOpen canBreakGlass={false} actions={{ open: vi.fn(), revoke: vi.fn() }} />,
    );
    expect(global.document.querySelector("[data-scope-granted]")?.getAttribute("data-scope-granted")).toBe("true");

    cleanup();
    render(
      <SupportAccess
        t={t}
        workspaceId="ws-1"
        sessions={[]}
        scope={noSupportScope("ws-1", "EXPIRED")}
        canOpen
        canBreakGlass={false}
        actions={{ open: vi.fn(), revoke: vi.fn() }}
      />,
    );
    expect(global.document.querySelector("[data-scope-refusal]")?.getAttribute("data-scope-refusal")).toBe("EXPIRED");
  });

  it("offers an end control only for a session that is still live", () => {
    render(
      <SupportAccess
        t={t}
        workspaceId="ws-1"
        sessions={[session({ live: false, revokedAt: NOW })]}
        scope={granted}
        canOpen
        canBreakGlass={false}
        actions={{ open: vi.fn(), revoke: vi.fn() }}
      />,
    );

    expect(global.document.querySelector('[data-admin="revoke-session"]')).toBeNull();
    expect(global.document.querySelector('[data-session="sa-1"]')?.getAttribute("data-live")).toBe("false");
  });
});

describe("the kill switches", () => {
  const row = (overrides: Partial<KillSwitchRow> = {}): KillSwitchRow => ({
    suspensionId: "as-1",
    scope: "WORKSPACE",
    workspaceId: "ws-1",
    businessProfileId: null,
    channelAccountId: null,
    reason: "OPERATOR",
    note: "incident 77",
    since: NOW,
    until: null,
    byOperator: true,
    ...overrides,
  });

  it("says that inbound keeps running, because that is the property an operator has to trust", () => {
    render(<KillSwitches t={t} switches={[]} canOperate actions={{ pull: vi.fn(), lift: vi.fn() }} />);

    expect(global.document.querySelector('[data-admin="inbound-unaffected"]')?.textContent).toBe(text("admin.inboundKeepsRunning"));
  });

  it("offers no lift control for the system's own pause, and says why", () => {
    render(<KillSwitches t={t} switches={[row({ byOperator: false, reason: "BACKLOG" })]} canOperate actions={{ pull: vi.fn(), lift: vi.fn() }} />);

    expect(global.document.querySelector('[data-admin="lift-switch"]')).toBeNull();
    expect(global.document.querySelector('[data-switch-owner="system"]')?.textContent).toBe(text("admin.systemPause"));
  });

  it("offers no controls to a role that cannot operate them", () => {
    render(<KillSwitches t={t} switches={[row()]} canOperate={false} actions={{ pull: vi.fn(), lift: vi.fn() }} />);

    expect(global.document.querySelector('[data-admin="pull-switch"]')).toBeNull();
    expect(global.document.querySelector('[data-admin="lift-switch"]')).toBeNull();
    expect(global.document.querySelector('[data-admin="cannot-operate-switch"]')?.textContent).toBe(text("admin.notYourRole"));
  });

  it("offers every scope the domain defines, so a narrower pause is reachable", () => {
    render(<KillSwitches t={t} switches={[]} workspaceId="ws-1" canOperate actions={{ pull: vi.fn(), lift: vi.fn() }} />);

    const options = [...global.document.querySelectorAll<HTMLOptionElement>('select[name="scope"] option')].map((option) => option.value);
    expect(options).toEqual(["GLOBAL", "WORKSPACE", "BUSINESS_PROFILE", "CHANNEL_ACCOUNT"]);
    // Pre-filled when the console is looking at one tenant, so the common case needs no copy-pasting.
    expect(global.document.querySelector<HTMLInputElement>('input[name="workspaceId"]')?.value).toBe("ws-1");
  });
});

describe("the reconciliation queue", () => {
  const row = (overrides: Partial<ReconciliationRow> = {}): ReconciliationRow => ({
    operationId: "op-1",
    workspaceId: "ws-1",
    businessProfileId: "bp-1",
    conversationId: "cv-1",
    reason: "AMBIGUOUS_SEND_RESULT",
    state: "PENDING",
    attemptCount: 2,
    detectedAt: NOW,
    lastAttemptAt: NOW,
    resolvedAt: null,
    evidence: "provider returned no identifier",
    providerRequestId: "pr-1",
    providerCode: null,
    correlationId: "corr-1",
    ...overrides,
  });

  it("says plainly that there is no resend here", () => {
    render(<ReconciliationQueue t={t} rows={[row()]} canOperate action={vi.fn()} workspacePath={(id) => `/admin/workspaces/${id}`} />);

    // A blind retry of an ambiguous non-idempotent write is how a customer receives the same message
    // twice, so the page says what the control does instead of leaving somebody to assume.
    expect(global.document.querySelector('[data-admin="no-blind-retry"]')?.textContent).toBe(text("admin.noBlindRetry"));
    expect(global.document.body.textContent).not.toContain("Resend");
  });

  it("carries the correlation id, so an operation can be followed", () => {
    render(<ReconciliationQueue t={t} rows={[row()]} canOperate action={vi.fn()} workspacePath={(id) => `/admin/workspaces/${id}`} />);

    expect(global.document.querySelector("[data-correlation-id]")?.getAttribute("data-correlation-id")).toBe("corr-1");
    expect(global.document.querySelector('[data-action="open-workspace"]')?.getAttribute("href")).toBe("/admin/workspaces/ws-1");
  });

  it("offers no control to a role that cannot operate it", () => {
    render(<ReconciliationQueue t={t} rows={[row()]} canOperate={false} action={vi.fn()} workspacePath={(id) => `/admin/workspaces/${id}`} />);

    expect(global.document.querySelector('[data-admin="reexamine"]')).toBeNull();
  });
});

describe("the internal audit table", () => {
  it("marks severity, so the two critical kinds are the ones that stand out", () => {
    render(
      <PlatformAuditTable
        t={t}
        rows={[
          {
            id: "pa-1",
            kind: "BREAK_GLASS_OPENED",
            severity: "CRITICAL",
            actorRole: "PLATFORM_ADMIN",
            actorName: "Dana",
            workspaceId: "ws-1",
            businessProfileId: null,
            subjectType: "SupportAccessSession",
            subjectId: "sa-1",
            reason: "incident 77",
            supportSessionId: "sa-1",
            detail: {},
            occurredAt: NOW,
          },
        ]}
      />,
    );

    const line = global.document.querySelector('[data-audit-row="pa-1"]');
    expect(line?.getAttribute("data-severity")).toBe("CRITICAL");
    expect(line?.textContent).toContain(text("platformAudit.BREAK_GLASS_OPENED"));
    // The reason is shown, because an action without one is what the table exists to make impossible.
    expect(line?.textContent).toContain("incident 77");
  });

  it("says plainly when nothing has been recorded", () => {
    render(<PlatformAuditTable t={t} rows={[]} />);

    expect(global.document.querySelector('[data-audit="none"]')?.textContent).toBe(text("admin.noAudit"));
  });
});
