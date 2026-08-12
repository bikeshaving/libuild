/**
 * esbuild service recovery.
 *
 * esbuild's JS API keeps ONE long-lived child process ("the service") per
 * module instance, and it does not respawn it. If that child dies - OOM-killed
 * under load, or reaped with the process group - every subsequent `build()` in
 * this process throws "The service is no longer running", forever. One
 * transient death therefore cascades into every remaining build: in libuild's
 * own suite a single service death turned a green run into 139 failures, all
 * from the same root cause, long after the event that caused it.
 *
 * `stop()` clears the dead handle so the next `build()` spawns a fresh service.
 * Verified: after SIGKILLing the service child, a plain retry still fails, and
 * a retry after `stop()` succeeds.
 */

import * as ESBuild from "esbuild";

const SERVICE_DEAD = /service is no longer running/i;

/** Injectable for tests - killing a real service process is slow and racy. */
export interface EsbuildDeps {
  build: (options: ESBuild.BuildOptions) => Promise<ESBuild.BuildResult>;
  stop: () => void;
}

const DEFAULT_DEPS: EsbuildDeps = {
  build: (options) => ESBuild.build(options),
  stop: () => ESBuild.stop(),
};

/**
 * Run an esbuild build, recovering once from a dead service.
 *
 * Only the service-death error is retried. Ordinary build failures (syntax
 * errors, unresolved imports) must surface on the first try - retrying those
 * would double the work and double the error output for no benefit.
 */
export async function build(
  options: ESBuild.BuildOptions,
  deps: EsbuildDeps = DEFAULT_DEPS
): Promise<ESBuild.BuildResult> {
  try {
    return await deps.build(options);
  } catch (error: any) {
    if (!SERVICE_DEAD.test(error?.message ?? String(error))) throw error;
    // Drop the dead handle, then let the next call spawn a new service.
    try {
      deps.stop();
    } catch {
      // stop() on an already-dead service is not itself interesting.
    }
    return await deps.build(options);
  }
}
