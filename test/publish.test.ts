import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// Test the parts of publish() we can test without mocking npm
test("publish() prerequisite: build creates dist/package.json", async () => {
  const testDir = await createTempDir("publish-prereq");
  
  // Copy fixture
  await copyFixture("simple-lib", testDir);
  
  // Build should create dist/package.json
  await build(testDir, true);
  
  // Verify dist/package.json exists (this is what publish() checks)
  const distPkgPath = path.join(testDir, "dist", "package.json");
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
});

test("publish() error case: no src directory", async () => {
  const testDir = await createTempDir("publish-no-src");
  
  // Create package.json but no src directory
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "test-pkg",
    version: "1.0.0",
    type: "module"
  }));
  
  // Build (which publish calls first) should fail
  await expect(build(testDir, true)).rejects.toThrow("No src/ directory found");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("publish() error case: no package.json", async () => {
  const testDir = await createTempDir("publish-no-pkg");
  
  // Create src but no package.json
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const hello = "world";');
  
  // Build (which publish calls first) should fail
  await expect(build(testDir, true)).rejects.toThrow();
  
  // Cleanup
  await removeTempDir(testDir);
});