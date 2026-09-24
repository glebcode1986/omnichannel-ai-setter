/**
 * The only way this package talks to Meta. The port sits BELOW the SendResult mapping so tests can script
 * status codes and Meta error bodies without a network, and it never rejects: a thrown transport error
 * would hide whether the request reached Meta, which ADR-012 forbids.
 */
export interface InstagramHttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  /** Already-serialized body; absent on GET. */
  readonly body?: string;
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

/**
 * Default `fetch`-backed port.
 *
 * `fetch` rejects with a `TypeError` for *every* transport failure — a refused connection, a DNS failure, a
 * socket reset after the request body was written, even a body read that fails after a 200 response. The
 * error therefore cannot tell us whether Meta received the message, so everything except a request we could
 * not even construct is reported as `NETWORK`, which the caller must treat as ambiguous (ADR-012).
 */
export function createFetchHttpPort(): InstagramHttpPort {
  return {
    async send(request) {
      // Checked before any I/O: this is the one failure that provably sent nothing.
      try {
        new URL(request.url);
      } catch {
        return { kind: "NO_RESPONSE", reason: "PRE_DISPATCH", message: "request URL is not valid" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: controller.signal,
        });
        // A body read can fail after a successful status; the send still happened, so it stays ambiguous.
        const body = await response.text();
        return { kind: "RESPONSE", status: response.status, body };
      } catch {
        return controller.signal.aborted
          ? { kind: "NO_RESPONSE", reason: "TIMEOUT", message: `request timed out after ${String(request.timeoutMs)} ms` }
          : { kind: "NO_RESPONSE", reason: "NETWORK", message: "network failure; delivery is unknown" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
