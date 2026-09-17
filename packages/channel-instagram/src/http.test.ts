import { describe, expect, it } from "vitest";

import { createFetchHttpPort } from "./http";

const request = (url: string) => ({
  url,
  method: "POST" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ recipient: { id: "x" }, message: { text: "hi" } }),
  timeoutMs: 2_000,
});

describe("default fetch transport", () => {
  it("reports a request it could not even construct as provably undispatched", async () => {
    const result = await createFetchHttpPort().send(request("not a url"));

    expect(result).toMatchObject({ kind: "NO_RESPONSE", reason: "PRE_DISPATCH" });
  });

  it("reports every transport failure as unknown delivery, never as undispatched", async () => {
    // Port 1 on loopback refuses immediately. `fetch` reports this the same way it reports a socket reset
    // after the body was written, so the port must not claim the request never left us.
    const result = await createFetchHttpPort().send(request("http://127.0.0.1:1/v26.0/me/messages"));

    expect(result).toMatchObject({ kind: "NO_RESPONSE", reason: "NETWORK" });
  });

  it("never rejects its promise, whatever the transport does", async () => {
    await expect(createFetchHttpPort().send(request("http://127.0.0.1:1/x"))).resolves.toBeDefined();
    await expect(createFetchHttpPort().send(request(""))).resolves.toMatchObject({ kind: "NO_RESPONSE" });
  });
});
