/**
 * What the Inbox is handed about a channel account (Issue #28).
 *
 * The acceptance criteria forbid provider-specific payloads reaching generic components, and the stored
 * record is exactly such a payload: a capabilities blob shaped by whichever platform wrote it, plus that
 * platform's own account id. This is the narrowing, tested on its own, because `no-provider-payloads`
 * can only see what the components mention — not what a server module decides to pass them.
 */
import { describe, expect, it } from "vitest";

import { channelAccountOptions } from "./inbox-accounts";

const record = (overrides: Partial<{ id: string; channel: string; displayName: string | null; externalAccountId: string }> = {}) => ({
  id: "ca_1",
  channel: "INSTAGRAM",
  displayName: "Studio Nord",
  externalAccountId: "17841400000000000",
  ...overrides,
});

describe("the channel filter's options", () => {
  it("prefers the name an operator would recognise", () => {
    expect(channelAccountOptions([record()])).toEqual([{ id: "ca_1", channel: "INSTAGRAM", label: "Studio Nord" }]);
  });

  it("falls back to the platform id when there is no name, rather than an empty label", () => {
    expect(channelAccountOptions([record({ displayName: null })])[0]?.label).toBe("17841400000000000");
  });

  it("carries nothing but the id, the channel and the label", () => {
    // Written as a key check: a record spread through by accident would pass a value assertion on these
    // three fields while dragging capabilities and credentials along behind them.
    const [option] = channelAccountOptions([{ ...record(), capabilities: { text: true }, accessToken: "secret" } as never]);

    expect(Object.keys(option ?? {}).sort()).toEqual(["channel", "id", "label"]);
  });

  it("keeps the order it was given, which is the order the accounts were connected", () => {
    const options = channelAccountOptions([record({ id: "ca_1" }), record({ id: "ca_2", channel: "WHATSAPP" })]);

    expect(options.map((option) => option.id)).toEqual(["ca_1", "ca_2"]);
  });

  it("returns nothing for a profile with nothing connected", () => {
    expect(channelAccountOptions([])).toEqual([]);
  });
});
