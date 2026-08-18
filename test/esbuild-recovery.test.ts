import {describe, expect, test} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {execSync} from "child_process";
import {build} from "../src/_esbuild.ts";
import {createTempDir, removeTempDir} from "./test-utils.ts";

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

  test("recovery is single-flight: concurrent failures stop() once", async () => {
    // stop() is process-global and esbuild strands in-flight requests on the
    // service it destroys. If every concurrently-failing build ran its own
    // stop()+retry, the second stop() would kill the fresh service the first
    // retry had just spawned - hanging that retry forever (the deadlock the
    // adversarial review reproduced). Only the FIRST failure from a given
    // service generation may stop(); the rest just retry.
    let stops = 0;
    let failures = 0;
    const deps = {
      build: async () => {
        if (failures < 4) { failures++; throw serviceDead(); }
        return {ok: true} as any;
      },
      stop: () => { stops++; },
    };

    const results = await Promise.all([
      build({} as any, deps),
      build({} as any, deps),
      build({} as any, deps),
      build({} as any, deps),
    ]);

    expect(results.every((r) => (r as any).ok)).toBe(true);
    expect(stops).toBe(1);
  });

  test('matches the in-flight death spelling ("was stopped") too', async () => {
    // Builds in flight when the service dies reject with "The service was
    // stopped", not "no longer running". Both must recover - concurrency
    // means most victims of a death see the FORMER.
    let attempts = 0;
    const result = await build({} as any, {
      build: async () => {
        if (++attempts === 1) throw new Error("The service was stopped");
        return {ok: true} as any;
      },
      stop: () => {},
    });
    expect(result).toEqual({ok: true} as any);
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

describe("esbuild service restart (integration, real service)", () => {
  // The fakes above prove the wrapper's logic; this proves the claim the
  // wrapper is BUILT on - that after the real service child dies, a plain
  // build stays dead but the wrapper's stop()+retry spawns a fresh service.
  // If a future esbuild changes its service lifecycle or error strings, this
  // is the test that notices.
  test("SIGKILLed service: plain build fails, wrapped build recovers", async () => {
    const tempDir = await createTempDir("esbuild-restart");
    try {
      const entry = Path.join(tempDir, "in.js");
      await FS.writeFile(entry, "export const x = 1;\n");
      const opts = {
        entryPoints: [entry],
        bundle: true,
        outfile: Path.join(tempDir, "out.js"),
        logLevel: "silent",
      } as any;

      // Healthy build first - this is what spawns the service child.
      await build(opts);

      // Kill only OUR OWN service child, never a machine-wide match: under
      // per-file isolation, sibling shard processes have their own services,
      // and killing theirs would make this test the very cascade-failure it
      // exists to prevent. `ps` rather than `pgrep -P`: portable across
      // macOS/Linux (pgrep -P -f missed the child on ubuntu CI), and the raw
      // table makes a zero-match failure diagnosable instead of a bare count.
      const psOut = execSync("ps -ax -o pid=,ppid=,command=", {encoding: "utf-8"});
      const pids = psOut.split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
        .filter((m): m is RegExpMatchArray =>
          m != null && parseInt(m[2], 10) === process.pid && m[3].includes("esbuild"))
        .map((m) => m[1]);
      if (pids.length === 0) {
        throw new Error(`no esbuild service child of pid ${process.pid} found; children:\n` +
          psOut.split("\n").filter((l) => l.trim().split(/\s+/)[1] === String(process.pid)).join("\n"));
      }
      for (const pid of pids) process.kill(parseInt(pid, 10), "SIGKILL");
      // Give esbuild's JS side a beat to observe the closed streams.
      await new Promise((r) => setTimeout(r, 300));

      // A plain (unwrapped) build must fail - this is the disease. If this
      // ever starts succeeding, esbuild has learned to respawn on its own
      // and the wrapper is obsolete.
      const ESBuild = await import("esbuild");
      await ESBuild.build(opts).then(
        () => { throw new Error("expected the unwrapped build to reject"); },
        (error: any) => {
          expect(String(error?.message ?? error)).toMatch(/service (is no longer running|was stopped)/i);
        },
      );

      // The wrapped build recovers (stop() + retry spawns a fresh service)...
      await build(opts);
      // ...and the service stays healthy for subsequent builds.
      await build(opts);
      const out = await FS.readFile(Path.join(tempDir, "out.js"), "utf-8");
      expect(out).toContain("x = 1");
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
