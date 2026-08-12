import {describe, expect, test} from "bun:test";
import {build} from "../src/_esbuild.ts";

// esbuild keeps one long-lived service child per module instance and never
// respawns it, so a single service death used to poison every later build in
// the process (one such death turned a green run of libuild's own suite into
// 139 failures). These drive the wrapper with fakes: killing a real service is
// slow and racy, and the behavior under test is entirely in the error handling.

const serviceDead = () => new Error("The service is no longer running");

describe("esbuild service recovery", () => {
  test("retries once after stop() when the service has died", async () => {
    const calls: string[] = [];
    let attempts = 0;
    const result = await build({} as any, {
      build: async () => {
        calls.push("build");
        if (++attempts === 1) throw serviceDead();
        return {ok: true} as any;
      },
      stop: () => { calls.push("stop"); },
    });

    expect(result).toEqual({ok: true} as any);
    // stop() MUST come between the two builds: without it the fresh build hits
    // the same dead handle and fails again (verified against a real service).
    expect(calls).toEqual(["build", "stop", "build"]);
  });

  test("does not retry ordinary build failures", async () => {
    let attempts = 0;
    let stopped = false;
    const failing = build({} as any, {
      build: async () => { attempts++; throw new Error("Could not resolve \"./nope\""); },
      stop: () => { stopped = true; },
    });

    await failing.then(
      () => { throw new Error("expected the build to reject"); },
      (error: any) => { expect(error.message).toMatch(/Could not resolve/); },
    );
    // Retrying a syntax/resolution error just doubles the work and the output.
    expect(attempts).toBe(1);
    expect(stopped).toBe(false);
  });

  test("surfaces the error when the retry also fails", async () => {
    let attempts = 0;
    const failing = build({} as any, {
      build: async () => { attempts++; throw serviceDead(); },
      stop: () => {},
    });

    await failing.then(
      () => { throw new Error("expected the build to reject"); },
      (error: any) => { expect(error.message).toMatch(/service is no longer running/); },
    );
    expect(attempts).toBe(2);
  });

  test("a throwing stop() does not mask the recovery", async () => {
    let attempts = 0;
    const result = await build({} as any, {
      build: async () => {
        if (++attempts === 1) throw serviceDead();
        return {ok: true} as any;
      },
      stop: () => { throw new Error("stop() blew up"); },
    });

    expect(result).toEqual({ok: true} as any);
    expect(attempts).toBe(2);
  });
});
