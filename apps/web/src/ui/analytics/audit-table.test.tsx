// @vitest-environment jsdom
/**
 * The audit log on screen (Issue #34).
 *
 * The cases that matter are the two things the page says out loud: that these records cannot be edited,
 * and that an Agent may be seeing fewer of them than an admin would. Both are claims a reader needs in
 * order to interpret what they are looking at, and neither is visible from the rows themselves.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEventView } from "@omnichannel/db";

import { AuditTable } from "./audit-table";
import { catalogues, type MessageKey } from "@/i18n/catalogue";
import { createTranslator } from "@/i18n/translate";

const t = createTranslator("en");
const text = (key: MessageKey) => catalogues.en[key];

afterEach(cleanup);

const row = (overrides: Partial<AuditEventView> = {}): AuditEventView => ({
  id: "evt_1",
  kind: "MODE_CHANGED",
  actorKind: "USER",
  actorName: "Ana Ruiz",
  occurredAt: new Date("2026-10-03T07:30:00.000Z"),
  summary: "Changed the mode from OFF to DRAFT",
  subjectType: "automation_policies",
  subjectId: "pol_1",
  businessProfileId: "bp_1",
  channelAccountId: null,
  conversationId: null,
  sensitive: false,
  detail: {},
  ...overrides,
});

describe("the audit log", () => {
  it("says these records cannot be changed", () => {
    render(<AuditTable t={t} rows={[row()]} restricted={false} timeZone="UTC" />);

    // A log a reader believes is editable is a log they discount. The trigger enforces it; this is where
    // they are told.
    expect(screen.getByText(text("audit.appendOnly"))).toBeDefined();
  });

  it("tells an Agent that others see more, without showing what", () => {
    render(<AuditTable t={t} rows={[row()]} restricted timeZone="UTC" />);

    // Not a redaction: the rows are genuinely absent from their query. But a reader who did not know
    // would draw conclusions from the gap.
    expect(screen.getByText(text("audit.restricted"))).toBeDefined();
    expect(document.querySelector('[data-restricted="true"]')).not.toBeNull();
  });

  it("says nothing of the kind to an admin", () => {
    render(<AuditTable t={t} rows={[row()]} restricted={false} timeZone="UTC" />);

    expect(screen.queryByText(text("audit.restricted"))).toBeNull();
  });

  it("names the person who acted, and says automatic when nobody did", () => {
    render(
      <AuditTable
        t={t}
        rows={[row(), row({ id: "evt_2", actorKind: "SYSTEM", actorName: null, kind: "AMBIGUOUS_SEND_RESOLVED", summary: "Reconciliation found the message had gone out" })]}
        restricted={false}
        timeZone="UTC"
      />
    );

    expect(screen.getByText("Ana Ruiz")).toBeDefined();
    // Reconciliation acts on its own. Putting a name against it would be a lie.
    expect(screen.getByText(text("audit.system"))).toBeDefined();
  });

  it("shows the time in the zone the reader chose, so both screens agree", () => {
    const { rerender } = render(<AuditTable t={t} rows={[row()]} restricted={false} timeZone="UTC" />);
    expect(screen.getByText("2026-10-03, 07:30")).toBeDefined();

    rerender(<AuditTable t={t} rows={[row()]} restricted={false} timeZone="Europe/Madrid" />);
    // The same instant, two hours later in local terms — and the metrics page is bucketing days by the
    // same choice.
    expect(screen.getByText("2026-10-03, 09:30")).toBeDefined();
  });

  it("names the action in words rather than showing the enum", () => {
    render(<AuditTable t={t} rows={[row()]} restricted={false} timeZone="UTC" />);

    expect(screen.getByText(text("audit.kind.MODE_CHANGED"))).toBeDefined();
    const table = document.querySelector("table") as HTMLElement;
    expect(within(table).queryByText("MODE_CHANGED")).toBeNull();
  });

  it("offers an older page only when there is one", () => {
    const { rerender } = render(<AuditTable t={t} rows={[row()]} restricted={false} timeZone="UTC" />);
    expect(document.querySelector('[data-audit-older="true"]')).toBeNull();

    rerender(<AuditTable t={t} rows={[row()]} restricted={false} timeZone="UTC" olderHref="/audit?before=x" />);
    // A link that loaded nothing would be worse than no link.
    expect(document.querySelector('[data-audit-older="true"]')?.getAttribute("href")).toBe("/audit?before=x");
  });

  it("says nothing matches rather than rendering an empty table", () => {
    render(<AuditTable t={t} rows={[]} restricted={false} timeZone="UTC" />);

    expect(screen.getByText(text("audit.empty"))).toBeDefined();
    expect(document.querySelector("table")).toBeNull();
    // The immutability notice stays: it is true of the log whether or not this filter found anything.
    expect(screen.getByText(text("audit.appendOnly"))).toBeDefined();
  });
});
