import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {spawn} from "child_process";
import {createTempDir, removeTempDir} from "./test-utils.ts";

test("publish command forwards extra arguments to npm", async () => {
  const testDir = await createTempDir("publish-args-test");
  
  // Create a simple package
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "publish-args-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));
  
  // Test that --dry-run flag is passed to npm publish
  const proc = spawn("bun", ["run", path.join(process.cwd(), "src/cli.ts"), "publish", "--dry-run"], {
    cwd: testDir,
    stdio: "pipe"
  });
  
  let output = "";
  proc.stdout?.on("data", (data) => {
    output += data.toString();
  });
  
  proc.stderr?.on("data", (data) => {
    output += data.toString();
  });
  
  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code || 0));
  });
  
  // npm publish --dry-run should exit with code 0 and show what would be published
  expect(exitCode).toBe(0);
  expect(output).toContain("npm notice"); // npm --dry-run shows notices
  
  await removeTempDir(testDir);
});

test("publish command with multiple flags", async () => {
  const testDir = await createTempDir("publish-multi-args-test");
  
  // Create a simple package
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const test = "value";');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "publish-multi-args-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));
  
  // Test that multiple flags are passed correctly
  const proc = spawn("bun", [
    "run", path.join(process.cwd(), "src/cli.ts"), 
    "publish", "--dry-run", "--tag", "beta"
  ], {
    cwd: testDir,
    stdio: "pipe"
  });
  
  let output = "";
  proc.stdout?.on("data", (data) => {
    output += data.toString();
  });
  
  proc.stderr?.on("data", (data) => {
    output += data.toString();
  });
  
  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => resolve(code || 0));
  });
  
  expect(exitCode).toBe(0);
  expect(output).toContain("npm notice"); // Should show dry-run output
  
  await removeTempDir(testDir);
});