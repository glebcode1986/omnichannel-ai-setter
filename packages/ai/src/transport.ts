/**
 * The only way this package talks to a model provider.
 *
 * The port sits below the mapping so every test scripts responses without a network or an API key, and it
 * never rejects: a thrown transport error would be indistinguishable from a provider that answered
 * something unusable. Unlike an outbound message, a failed generation is safe to retry — nothing was sent —
 * so the distinction that matters here is "answered" versus "did not answer", not ambiguity.
 */
export interface ModelHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}

export type ModelHttpResult =
  | { readonly kind: "RESPONSE"; readonly status: number; readonly body: string; readonly requestId?: string }
  | { readonly kind: "NO_RESPONSE"; readonly reason: "TIMEOUT" | "NETWORK" | "PRE_DISPATCH" };

export interface ModelHttpPort {
  send(request: ModelHttpRequest): Promise<ModelHttpResult>;
}

/** Default `fetch`-backed transport. Reads the provider's request ID header for the audit trail. */
export function createFetchModelHttpPort(): ModelHttpPort {
  return {
    async send(request) {
      try {
        new URL(request.url);
      } catch {
        return { kind: "NO_RESPONSE", reason: "PRE_DISPATCH" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: "POST",
          headers: { ...request.headers },
          body: request.body,
          signal: controller.signal,
        });
        const body = await response.text();
        const requestId = response.headers.get("request-id") ?? undefined;
        return { kind: "RESPONSE", status: response.status, body, ...(requestId === undefined ? {} : { requestId }) };
      } catch {
        return controller.signal.aborted ? { kind: "NO_RESPONSE", reason: "TIMEOUT" } : { kind: "NO_RESPONSE", reason: "NETWORK" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
