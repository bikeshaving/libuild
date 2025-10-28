import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {spawn} from "child_process";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// Security Tests
// =============================================================================

test("rejects path traversal in files field", async () => {
  const testDir = await createTempDir("path-traversal-test");
  
  // Create package.json with malicious files field
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "path-traversal-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: ["../../../etc/passwd"] // Malicious path traversal
  }));
  
  // Create src directory
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  
  // Build should fail with path traversal error
  await expect(build(testDir, false)).rejects.toThrow("Path traversal is not allowed");
  
  await removeTempDir(testDir);
});

test("rejects absolute paths in files field", async () => {
  const testDir = await createTempDir("absolute-path-test");
  
  // Create package.json with malicious files field
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "absolute-path-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: ["/etc/passwd"] // Absolute path
  }));
  
  // Create src directory
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  
  // Build should fail with absolute path error
  await expect(build(testDir, false)).rejects.toThrow("Absolute paths are not allowed");
  
  await removeTempDir(testDir);
});

test("filters dangerous npm flags", async () => {
  const testDir = await createTempDir("dangerous-flags-test");
  
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "dangerous-flags-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));
  
  // Test with dangerous command injection attempt - extra arguments
  const proc = spawn("bun", [
    "run", Path.join(process.cwd(), "src/cli.ts"),
    "publish", "--dry-run", "malicious-arg", "another-arg"
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
  // The dangerous arguments should be filtered out
  expect(output).toContain("Warning: Ignoring unexpected argument: malicious-arg");
  expect(output).toContain("Warning: Ignoring unexpected argument: another-arg");
  // The build should still succeed with just --dry-run
  expect(output).toContain("npm notice");
  
  await removeTempDir(testDir);
});

test("only allows whitelisted npm flags", async () => {
  const testDir = await createTempDir("whitelist-test");
  
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "whitelist-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));
  
  // Test with mix of allowed and disallowed flags
  const proc = spawn("bun", [
    "run", Path.join(process.cwd(), "src/cli.ts"),
    "publish", "--dry-run", "--tag", "beta", "--unsafe-perm", "--script-shell", "/bin/sh"
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
  // Should warn about unsafe flags
  expect(output).toContain("Warning: Ignoring unknown/unsafe npm flag: --unsafe-perm");
  expect(output).toContain("Warning: Ignoring unknown/unsafe npm flag: --script-shell");
  // Should still include the safe ones
  expect(output).toContain("with tag beta");
  
  await removeTempDir(testDir);
});

test("validates flag-value pairs correctly", async () => {
  const testDir = await createTempDir("flag-value-test");
  
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "flag-value-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));
  
  // Test that flag-value pairs work correctly
  const proc = spawn("bun", [
    "run", Path.join(process.cwd(), "src/cli.ts"),
    "publish", "--dry-run", "--tag", "beta", "--access", "public"
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
  expect(output).toContain("with tag beta");
  expect(output).toContain("public access");
  // Should not have any warnings for these valid flags
  expect(output).not.toContain("Warning:");
  
  await removeTempDir(testDir);
});