/**
 * Hostnames a standard reserves, and which therefore cannot belong to any deployment.
 *
 * This exists to answer one question honestly: can a provider's callback ever arrive at the address this
 * deployment has configured? A development host carrying a placeholder redirect URI passes every other
 * check — it is a syntactically valid HTTPS URL — and the product otherwise has no way to tell it apart
 * from a real one. So the operator was sent to Meta, Meta refused an app id it had never heard of, and the
 * screen they landed on was Meta's "page isn't available" with nothing of ours on it.
 *
 * **Only names a standard guarantees are unusable.** RFC 2606 §2 reserves the top-level domains `test`,
 * `example`, `invalid` and `localhost`; §3 reserves `example.com`, `example.net` and `example.org`. RFC
 * 6761 §6.4 adds that resolvers should not even send queries for a name under `invalid`.
 *
 * **`localhost` and `test` are deliberately not refused**, which is the part worth writing down, because
 * it looks like an omission. An OAuth redirect is followed by *the operator's own browser* — the provider
 * answers the authorize request with a redirect to the user agent and never fetches the address itself —
 * so `https://localhost:3000/…`, which is what `.env.example` ships, or a `.test` name a developer keeps
 * in `/etc/hosts`, is a working configuration rather than a broken one. What is refused is the set of
 * names that resolve for nobody, anywhere: those can only ever have been placeholders.
 *
 * **It says nothing about the credentials beside the address.** An app id is an opaque string to us, and
 * no documentation we could find states a format for Meta's, so a deployment with a plausible redirect
 * URI and a nonsense app id is still offered the connection and still fails at the provider. This
 * function does not claim to catch that; the explicit way to say "this installation has no Instagram app"
 * is to leave the credentials unset, which `instagramOAuthConfigured` reads.
 */

/** RFC 2606 §2, minus the two whose names a browser on the operator's own machine can still reach. */
const RESERVED_TOP_LEVEL: ReadonlySet<string> = new Set(["invalid", "example"]);

/** RFC 2606 §3. Reserved for documentation, so no deployment can serve a callback from one. */
const RESERVED_SECOND_LEVEL: ReadonlySet<string> = new Set(["example.com", "example.net", "example.org"]);

/**
 * Whether this hostname is one nobody can own.
 *
 * Takes a hostname rather than a URL so the caller is the one that decides what part of an address is
 * being judged, and so this has no opinion about scheme, port or path.
 */
export function isReservedHostname(hostname: string): boolean {
  // A fully qualified name may carry a trailing root dot, and comparison is case-insensitive (RFC 4343).
  const labels = hostname.toLowerCase().replace(/\.$/u, "").split(".");
  const top = labels[labels.length - 1];
  if (top !== undefined && RESERVED_TOP_LEVEL.has(top)) {
    return true;
  }
  // `slice(-2)` on a single-label name yields that name, which is in neither set, so a bare host is not
  // reserved by accident.
  return labels.length >= 2 && RESERVED_SECOND_LEVEL.has(labels.slice(-2).join("."));
}
