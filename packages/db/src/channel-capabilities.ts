/**
 * Reading the capabilities column without pretending it is typed.
 *
 * `channel_accounts.capabilities` is JSON an earlier connect wrote, so its shape is whatever that
 * deployment's adapter believed at the time — a row written before a capability existed simply does not
 * have the key. Casting it to `ChannelCapabilities` would make every reader trust a shape nobody checked,
 * which is why `setup-store.ts` narrows to one boolean and `presenceCapabilitiesOf` to two rather than
 * casting. This is the same narrowing for the whole interface, in one place.
 *
 * Every absent key reads as `false`. For a capability that gates an action that is the safe direction, and
 * for `nativeOutboundVisible` it is the safe direction twice over: a row written before coexistence
 * existed says "we cannot see replies sent outside this product", which is exactly what was true.
 */
import { CHANNEL_CAPABILITY_KEYS, NO_CAPABILITIES, type ChannelCapabilities } from "@omnichannel/domain";

export function channelCapabilitiesOf(stored: unknown): ChannelCapabilities {
  const row = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const capabilities: Record<string, boolean> = { ...NO_CAPABILITIES };
  for (const key of CHANNEL_CAPABILITY_KEYS) {
    capabilities[key] = row[key] === true;
  }
  return capabilities as unknown as ChannelCapabilities;
}
