/**
 * The only way this package talks to Meta. The port sits BELOW the SendResult mapping so tests can script
 * status codes and Meta error bodies without a network, and it never rejects: a thrown transport error
 * would hide whether the request reached Meta, which ADR-012 forbids.
 */
export interface InstagramHttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** Already-serialized JSON body. */
  readonly body: string;
  readonly timeoutMs: number;
}

export type InstagramHttpResult =
  | { readonly kind: "RESPONSE"; readonly status: number; readonly body: string }
  /**
   * `PRE_DISPATCH` means the request provably never left us (bad URL, refused connection), so it is safe to
   * retry. `TIMEOUT` and `NETWORK` happen after the bytes may have reached Meta, so the outcome is unknown.
   */
  | { readonly kind: "NO_RESPONSE"; readonly reason: "PRE_DISPATCH" | "TIMEOUT" | "NETWORK"; readonly message: string };

export interface InstagramHttpPort {
  send(request: InstagramHttpRequest): Promise<InstagramHttpResult>;
}

/** Default `fetch`-backed port. Distinguishes "never dispatched" from "unknown" as carefully as fetch allows. */
export function createFetchHttpPort(): InstagramHttpPort {
  return {
    async send(request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          signal: controller.signal,
        });
        return { kind: "RESPONSE", status: response.status, body: await response.text() };
      } catch (error) {
        if (controller.signal.aborted) {
          return { kind: "NO_RESPONSE", reason: "TIMEOUT", message: `request timed out after ${String(request.timeoutMs)} ms` };
        }
        // fetch rejects for DNS/TLS/connection failures too; those may still have opened a connection, so
        // only an invalid request (rejected before any I/O) is reported as safely undispatched.
        const name = error instanceof Error ? error.name : typeof error;
        return name === "TypeError"
          ? { kind: "NO_RESPONSE", reason: "PRE_DISPATCH", message: "request could not be dispatched" }
          : { kind: "NO_RESPONSE", reason: "NETWORK", message: "network failure after dispatch" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
