import type { ChannelAdapterProvider } from "@omnichannel/application";

/**
 * Channel adapters available to webhook ingestion in this deployment. None are registered yet: the
 * Instagram adapter (Phase 2) and WhatsApp adapter (Phase 4) add themselves here, so until then every
 * webhook route answers 404 without touching storage.
 */
export const channelAdapters: ChannelAdapterProvider = {
  adapterFor: () => undefined,
};
