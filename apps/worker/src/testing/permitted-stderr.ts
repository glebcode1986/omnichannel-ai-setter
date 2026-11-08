/**
 * Every warning the worker may legitimately write to stderr in a run with no infrastructure behind it.
 *
 * One list, because there were two and they disagreed. `main.test.ts` permitted five events;
 * `bundle.test.ts` spawned the same entrypoint, read the same stderr and checked it against its own copy
 * of four — missing `worker.lingering_after_stop`, the one event both files' own prose describes as
 * expected on a loaded machine. So `pnpm verify` failed, on this machine, on a condition the project had
 * already decided was acceptable: the bundle test was asserting that a documented outcome must not
 * happen. A copied list is a list that drifts, and this is what the drift cost.
 *
 * The five, and why each is allowed:
 *
 * - `queue.redis_unavailable`: Redis is deliberately unreachable in these runs, and surviving it quietly
 *   — without echoing the URL — is the point.
 * - `queue.client_error`: a queue client's own connection failure, carrying the error's name and code and
 *   never the URL. The monitor used to drop this one, and dropping it is what killed the worker during
 *   the outage it was built to survive, so its presence here is the fix rather than noise. One per queue
 *   family per outage, which is why a run without Redis produces four.
 * - `worker.no_channel_adapter`: no Meta app credentials are configured, so the worker announces at boot
 *   that it cannot deliver rather than discovering it on the first customer message.
 * - `worker.no_media_port`: no credential-encryption key is configured, so no stored access token can be
 *   decrypted and no recording fetched. Announced at boot for the same reason as the line above, and a
 *   voice note then fails with a named reason that becomes a review item (Issue #21).
 * - `worker.lingering_after_stop`: the process outlived its own shutdown deadline because a handle some
 *   library owns stayed open after everything the worker owns had closed. **Not a failed shutdown** — the
 *   worker reports it and still exits 0 (see `shutdown.ts`). Rare on an idle machine, ordinary on a
 *   loaded one, which is exactly when a CI runner or a developer's laptop is running this suite.
 *
 * A genuine shutdown timeout is a different event, at error level, and would fail both the stderr check
 * and the exit code. What keeps this list from becoming a way to admit a leak is the separate assertion
 * that the Redis URL never appears in the output — every caller makes it, and it is not optional.
 */
export const PERMITTED_STDERR_EVENTS: readonly string[] = [
  "queue.redis_unavailable",
  "queue.client_error",
  "worker.no_channel_adapter",
  "worker.no_media_port",
  "worker.lingering_after_stop",
];

/** The events a run actually produced, one per JSON line, ignoring anything that is not a log line. */
export function stderrEvents(stderr: string): readonly string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return (JSON.parse(line) as { event?: unknown }).event;
      } catch {
        // A non-JSON line is not a log line this worker wrote, and silently dropping it would let a crash
        // dump through the check. Returned as itself so the caller reports it.
        return line;
      }
    })
    // `String`, not `JSON.stringify`: a line with no `event` field at all stringifies to the *value*
    // `undefined`, which would have put a hole in an array this function declares as strings — and the
    // caller would then report a missing event as an empty slot rather than as something to look at.
    .map((event) => (typeof event === "string" ? event : String(event)));
}

/** Whatever stderr carried that this list does not allow. Empty is the only acceptable answer. */
export function unexpectedStderrEvents(stderr: string): readonly string[] {
  return stderrEvents(stderr).filter((event) => !PERMITTED_STDERR_EVENTS.includes(event));
}
