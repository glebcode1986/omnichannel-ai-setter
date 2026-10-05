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
  /**
   * JSON for a text request, raw bytes for one that carries a file.
   *
   * Bytes are a separate case rather than a string because they have to be: a multipart body holding
   * audio cannot survive being encoded as UTF-8, and a string body is encoded that way. The audio
   * transcription adapter (Issue #21) is the caller that needs it.
   */
  readonly body: string | Uint8Array;
  readonly timeoutMs: number;
}

export type ModelHttpResult =
  | {
      readonly kind: "RESPONSE";
      readonly status: number;
      readonly body: string;
      readonly requestId?: string;
      /**
       * The provider's own `Retry-After`, in seconds, when it sent one.
       *
       * Read here because it is an instruction rather than a hint: a provider that says how long to wait
       * has told us something no backoff formula knows, and ignoring it is how a throttled worker becomes
       * the reason it stays throttled.
       */
      readonly retryAfterSeconds?: number;
    }
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
          // A `Uint8Array` is a valid request body at runtime — Node's `fetch` accepts any
          // `BufferSource` — but this package compiles against the Node types rather than the DOM ones,
          // where the parameter is typed too narrowly to say so. The cast is the typing gap, not a
          // behaviour one, and the bytes are handed over untouched either way.
          body: request.body as unknown as string,
          signal: controller.signal,
        });
        const body = await response.text();
        const requestId = response.headers.get("request-id") ?? undefined;
        const retryAfter = Number(response.headers.get("retry-after") ?? "");
        return {
          kind: "RESPONSE",
          status: response.status,
          body,
          ...(requestId === undefined ? {} : { requestId }),
          // Only a plain number of seconds is honoured. The header may also carry an HTTP date, and a
          // date parsed against our own clock is a guess about the provider's; a missing value simply
          // leaves the caller's own backoff in charge.
          ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: Math.ceil(retryAfter) } : {}),
        };
      } catch {
        return controller.signal.aborted ? { kind: "NO_RESPONSE", reason: "TIMEOUT" } : { kind: "NO_RESPONSE", reason: "NETWORK" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
