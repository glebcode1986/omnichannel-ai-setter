/**
 * Test-only preload: one escaped rejection from a source that is not Redis.
 *
 * It deliberately carries `ECONNREFUSED` — the same code a reconnecting Redis client produces — because
 * that is the case the guard must not be allowed to excuse. An error code and a dependency's current
 * state are circumstantial: two unrelated failures can share both, so an inference drawn from them would
 * sooner or later excuse the wrong one.
 *
 * Nothing about this rejection comes from a Redis client, and the worker must still stop.
 */
setTimeout(() => {
  void Promise.reject(Object.assign(new TypeError("an escaped rejection from somewhere that is not Redis"), { code: "ECONNREFUSED" }));
}, 700).unref();
