/**
 * A preload that keeps the process alive forever, standing in for the handle some library leaves open
 * after everything the worker owns has already been closed (Issue #5).
 *
 * The worker cannot close what it does not own, so the only question is what it says about it. This is
 * how the real case is produced on purpose: without it, the difference between a shutdown that hung and
 * a shutdown that finished is only ever observed on a loaded CI runner.
 */
setInterval(() => {
  // Deliberately ref'd: an unref'd timer would let the process exit and prove nothing.
}, 1_000);
