/**
 * What fetching a recording does when the deployment cannot read a token (Issue #21).
 *
 * Without the credential-encryption key there is no way to decrypt a stored access token, and therefore
 * no way to fetch a recording. The choice this file pins down is that the port says so by name: the
 * transcript row records the reason, the draft is held for a person, and an operator reading the log sees
 * a configuration problem rather than something that looks like a bug in the transcriber.
 */
import type { DbClient } from "@omnichannel/db";
import type { Logger } from "@omnichannel/observability";
import { describe, expect, it, vi } from "vitest";

import { createMediaPort, type MediaEnv } from "./media-port";

function logger() {
  const events: { level: string; event: string; fields?: Readonly<Record<string, unknown>> }[] = [];
  const record = (level: string) => (event: string, fields?: Readonly<Record<string, unknown>>) => {
    events.push({ level, event, ...(fields === undefined ? {} : { fields }) });
  };
  return {
    events,
    logger: { info: record("info"), warn: record("warn"), error: record("error"), debug: vi.fn(), child: vi.fn() } as unknown as Logger,
  };
}

/** Nothing is meant to reach the database on the refusing path, so every call through it is a failure. */
const noDatabase = new Proxy(
  {},
  {
    get() {
      throw new Error("the refusing media port must not touch the database");
    },
  },
) as DbClient;

const env = (overrides: Partial<MediaEnv> = {}): MediaEnv => ({
  CHANNEL_CREDENTIAL_KEY_ID: "test-key",
  CHANNEL_CREDENTIAL_KEY: Buffer.alloc(32, 3).toString("base64"),
  WHATSAPP_GRAPH_VERSION: "v26.0",
  MEDIA_MAX_DOWNLOAD_MB: 25,
  ...overrides,
});

const target = { workspaceId: "ws_1", businessProfileId: "bp_1", channelAccountId: "ca_1", providerMediaId: "wa-media-1" };

describe("the media port a deployment gets", () => {
  it("is built when the credential-encryption configuration is present", () => {
    const { logger: log, events } = logger();

    const port = createMediaPort(env(), noDatabase, log);

    expect(typeof port.fetch).toBe("function");
    expect(typeof port.delete).toBe("function");
    // Nothing is announced: a configured deployment has nothing to warn an operator about.
    expect(events).toEqual([]);
  });

  for (const missing of ["CHANNEL_CREDENTIAL_KEY_ID", "CHANNEL_CREDENTIAL_KEY"] as const) {
    it(`refuses by name, once, when ${missing} is absent`, async () => {
      const { logger: log, events } = logger();

      const port = createMediaPort(env({ [missing]: undefined }), noDatabase, log);

      // Neither retryable nor permanent: the deployment is misconfigured, which is not a fact about this
      // recording and not something a retry would fix. The row stays PENDING and says why.
      expect(await port.fetch(target)).toEqual({ ok: false, reason: "NO_CIPHER", retryable: false, permanent: false });
      // And the retention call answers honestly rather than claiming a deletion nobody performed.
      expect(await port.delete(target)).toBe(false);
      expect(events).toEqual([
        { level: "warn", event: "worker.no_media_port", fields: { reason: "credential-encryption configuration is missing" } },
      ]);
    });
  }

  it("never puts the encryption key in a log line", () => {
    const { logger: log, events } = logger();
    const key = Buffer.alloc(32, 11).toString("base64");

    createMediaPort(env({ CHANNEL_CREDENTIAL_KEY: key, CHANNEL_CREDENTIAL_KEY_ID: undefined }), noDatabase, log);

    expect(JSON.stringify(events)).not.toContain(key);
  });
});
