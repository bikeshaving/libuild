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

// Two spellings of the same event: builds started AFTER the death hit the
// pre-flight guard ("no longer running"); builds IN FLIGHT when it died are
// rejected by the close handler ("was stopped"). Both mean "dead service,
// retry against a fresh one"; missing the second left every in-flight shard
// unrecovered on each death.
const SERVICE_DEAD = /service is no longer running|service was stopped/i;

/** Injectable for tests - killing a real service process is slow and racy. */
export interface EsbuildDeps {
  build: (options: ESBuild.BuildOptions) => Promise<ESBuild.BuildResult>;
  stop: () => void;
}

const DEFAULT_DEPS: EsbuildDeps = {
  build: (options) => ESBuild.build(options),
  stop: () => ESBuild.stop(),
};

// Service generation, for SINGLE-FLIGHT recovery. stop() is process-global:
// it kills whatever service exists NOW, and esbuild's close handling strands
// (never settles) requests in flight on the stream it destroys. The test
// runner races many concurrent builds, so when a service dies they ALL fail
// together - if each caller then ran its own stop()+retry, the second stop()
// would kill the fresh service the first retry just spawned, hanging that
// retry forever. Instead each build records the generation it started under,
// and only the FIRST failure from a given generation performs the stop();
// everyone else just retries against the already-recovered service.
let generation = 0;

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
  const gen = generation;
  try {
    return await deps.build(options);
  } catch (error: any) {
    if (!SERVICE_DEAD.test(error?.message ?? String(error))) throw error;
    // Single-flight: only recover if nobody has since our attempt began.
    // (No await between the check and the increment, so this is atomic.)
    if (generation === gen) {
      generation++;
      try {
        deps.stop();
      } catch {
        // stop() on an already-dead service is not itself interesting.
      }
    }
    return await deps.build(options);
  }
}
