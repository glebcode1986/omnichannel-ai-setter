/**
 * Test-only preload: schedules one escaped rejection that has nothing to do with Redis.
 *
 * The worker's child-process regression loads this to tell the two cases apart from outside the process.
 * Deliberately a `TypeError` carrying no error code, so the rule under test cannot mistake it for a
 * connection failure — which is the whole point of the comparison.
 */
setTimeout(() => {
  void Promise.reject(new TypeError("an escaped rejection from somewhere that is not Redis"));
}, 700).unref();
