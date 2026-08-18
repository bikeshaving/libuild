import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {spawn} from "child_process";
import {build} from "../src/internal/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// Test the parts of publish() we can test without mocking npm
test("publish() prerequisite: build creates dist/package.json", async () => {
  const testDir = await createTempDir("publish-prereq");

  // Copy fixture
  await copyFixture("simple-lib", testDir);

  // Build should create dist/package.json
  await build(testDir, true);

  // Verify dist/package.json exists (this is what publish() checks)
  const distPkgPath = Path.join(testDir, "dist", "package.json");
  expect(await fileExists(distPkgPath)).toBe(true);

  // Verify the dist package.json has the expected structure for publishing
  const distPkg = await readJSON(distPkgPath);
  expect(distPkg.name).toBeDefined();
  expect(distPkg.version).toBeDefined();
  expect(distPkg.main).toBeDefined();
  expect(distPkg.module).toBeDefined();
  expect(distPkg.types).toBeDefined();

  // Cleanup
  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load

test("publish() error case: no src directory", async () => {
  const testDir = await createTempDir("publish-no-src");

  // Create package.json but no src directory
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "test-pkg",
    version: "1.0.0",
    type: "module"
  }));

  // Build (which publish calls first) should fail
  expect(build(testDir, true)).rejects.toThrow("No src/ directory found");

  // Cleanup
  await removeTempDir(testDir);
});

test("publish() error case: no package.json", async () => {
  const testDir = await createTempDir("publish-no-pkg");

  // Create src but no package.json
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const hello = "world";');

  // Build (which publish calls first) should fail
  expect(build(testDir, true)).rejects.toThrow();

  // Cleanup
  await removeTempDir(testDir);
});

// =============================================================================
// Publish Command Flag Forwarding Tests
// =============================================================================

test("publish command forwards basic flags to npm", async () => {
  const testDir = await createTempDir("publish-args-test");

  // Create a simple package
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "publish-args-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));

  // Test that --dry-run flag is passed to npm publish
  const proc = spawn("bun", ["run", Path.join(process.cwd(), "src/cli.ts"), "publish", "--dry-run"], {
    cwd: testDir,
    stdio: "pipe"
  });

  let output = "";
  proc.stdout?.on("data", (data) => output += data.toString());
  proc.stderr?.on("data", (data) => output += data.toString());

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code || 0));
  });

  expect(exitCode).toBe(0);
  expect(output).toContain("npm notice"); // npm --dry-run shows notices

  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load

test("publish command forwards multiple flags correctly", async () => {
  const testDir = await createTempDir("publish-multi-args-test");

  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "publish-multi-args-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));

  const proc = spawn("bun", [
    "run", Path.join(process.cwd(), "src/cli.ts"),
    "publish", "--dry-run", "--tag", "beta"
  ], {
    cwd: testDir,
    stdio: "pipe"
  });

  let output = "";
  proc.stdout?.on("data", (data) => output += data.toString());
  proc.stderr?.on("data", (data) => output += data.toString());

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code || 0));
  });

  expect(exitCode).toBe(0);
  expect(output).toContain("npm notice");

  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load

test("publish handles conflicting access flags (user overrides libuild)", async () => {
  const testDir = await createTempDir("access-conflict-test");

  // Create a scoped package (which triggers automatic --access public)
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "@test/access-conflict",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));

  // Test that user's --access restricted overrides our automatic --access public
  const proc = spawn("bun", [
    "run", Path.join(process.cwd(), "src/cli.ts"),
    "publish", "--dry-run", "--access", "restricted"
  ], {
    cwd: testDir,
    stdio: "pipe"
  });

  let output = "";
  proc.stdout?.on("data", (data) => output += data.toString());
  proc.stderr?.on("data", (data) => output += data.toString());

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code || 0));
  });

  expect(exitCode).toBe(0);
  expect(output).toContain("npm notice");
  // Should show "restricted access" indicating user's flag won
  expect(output).toContain("restricted access");

  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load

test("publish handles unknown npm flags gracefully", async () => {
  const testDir = await createTempDir("invalid-flag-test");

  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-flag-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));

  // Test with unknown npm flag
  const proc = spawn("bun", [
    "run", Path.join(process.cwd(), "src/cli.ts"),
    "publish", "--invalid-flag", "--dry-run"
  ], {
    cwd: testDir,
    stdio: "pipe"
  });

  let output = "";
  proc.stdout?.on("data", (data) => output += data.toString());
  proc.stderr?.on("data", (data) => output += data.toString());

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code || 0));
  });

  // libuild now filters out unknown flags and warns about them
  expect(exitCode).toBe(0);
  expect(output).toContain("npm notice");
  expect(output).toContain("Warning: Ignoring unknown/unsafe npm flag: --invalid-flag");

  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load

test("publish handles complex flag combinations", async () => {
  const testDir = await createTempDir("complex-flags-test");

  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "@test/complex-flags",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));

  // Test libuild flags mixed with npm flags and complex ordering
  const proc = spawn("bun", [
    "run", Path.join(process.cwd(), "src/cli.ts"),
    "--save", "publish", "--dry-run", "--access", "public", "--tag", "latest"
  ], {
    cwd: testDir,
    stdio: "pipe"
  });

  let output = "";
  proc.stdout?.on("data", (data) => output += data.toString());
  proc.stderr?.on("data", (data) => output += data.toString());

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code || 0));
  });

  expect(exitCode).toBe(0);
  expect(output).toContain("npm notice");
  expect(output).toContain("with tag latest"); // Should use user's tag

  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load

// =============================================================================
// Argument Parsing Logic Tests
// =============================================================================

test("verify extraArgs extraction logic", () => {
  // Test the argument extraction logic used in CLI
  const testCases = [
    {
      argv: ["libuild", "publish", "--dry-run", "--tag", "beta"],
      expected: ["--dry-run", "--tag", "beta"]
    },
    {
      argv: ["libuild", "--save", "publish", "--tag", "beta"],
      expected: ["--tag", "beta"]
    },
    {
      argv: ["libuild", "publish", "--save", "--tag", "beta"],
      expected: ["--tag", "beta"]
    },
    {
      argv: ["libuild", "--help", "publish", "--tag", "beta"],
      expected: ["--tag", "beta"]
    }
  ];

  for (const testCase of testCases) {
    // Simulate process.argv.slice(2)
    const args = testCase.argv.slice(2);
    const extraArgs = args.filter(arg =>
      !["build", "publish"].includes(arg) &&
      !["--save", "--no-save", "--help", "-h", "--version", "-v"].includes(arg)
    );

    expect(extraArgs).toEqual(testCase.expected);
  }
});

// ---------------------------------------------------------------------------
// libuild stage: a separate command, not a publish variant - the artifact
// does not go live, and a human approves it later with `npm stage approve`.
// ---------------------------------------------------------------------------

test("npmSupportsStaging: 11.15.0 is the floor", async () => {
  const {npmSupportsStaging} = await import("../src/internal/libuild.ts");
  expect(npmSupportsStaging("11.15.0")).toBe(true);
  expect(npmSupportsStaging("11.16.2")).toBe(true);
  expect(npmSupportsStaging("12.0.0")).toBe(true);
  expect(npmSupportsStaging("11.14.9")).toBe(false);
  expect(npmSupportsStaging("11.8.0")).toBe(false);
  expect(npmSupportsStaging("10.99.0")).toBe(false);
  expect(npmSupportsStaging("")).toBe(false);
  expect(npmSupportsStaging("garbage")).toBe(false);
});

test("stage refuses with a clear error when npm is too old (or explains staging)", async () => {
  const testDir = await createTempDir("stage-npm-version");
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const x = 1;');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "stage-version-test", version: "1.0.0", type: "module", private: true,
  }));

  const proc = spawn("bun", ["run", Path.join(process.cwd(), "src/cli.ts"), "stage", "--dry-run"], {
    cwd: testDir, stdio: "pipe",
  });
  let output = "";
  proc.stdout?.on("data", (d) => output += d.toString());
  proc.stderr?.on("data", (d) => output += d.toString());
  const exitCode = await new Promise<number>((resolve) => proc.on("close", (c) => resolve(c || 0)));

  // Preflights run before the build, so the refusal must be immediate and
  // named - never npm's own confusing "unknown command" failure. Which
  // preflight fires depends on the machine's npm:
  //  - npm < 11.15.0 -> the version gate, naming both versions
  //  - npm >= 11.15.0 -> the never-published gate for this fake package
  expect(exitCode).toBe(1);
  expect(output).toMatch(/staged publishing needs npm 11\.15\.0|has never been published/);
  expect(output).not.toMatch(/Unknown command/i);

  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load

test("stage is dispatched with the same whitelist parser as publish", async () => {
  const testDir = await createTempDir("stage-whitelist");
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const x = 1;');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "stage-whitelist-test", version: "1.0.0", type: "module", private: true,
  }));

  // An unsafe flag must be dropped with a warning by the shared whitelist -
  // BEFORE any preflight refusal exits the process.
  const proc = spawn("bun", ["run", Path.join(process.cwd(), "src/cli.ts"), "stage", "--ignore-scripts", "--dry-run"], {
    cwd: testDir, stdio: "pipe",
  });
  let output = "";
  proc.stdout?.on("data", (d) => output += d.toString());
  proc.stderr?.on("data", (d) => output += d.toString());
  await new Promise<number>((resolve) => proc.on("close", (c) => resolve(c || 0)));

  expect(output).toContain("Ignoring unknown/unsafe npm flag: --ignore-scripts");

  await removeTempDir(testDir);
}, 60000);  // spawns the full CLI (build + npm) - far beyond bun's 5s default under load
