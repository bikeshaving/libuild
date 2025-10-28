import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

test("shared modules are deduplicated across entry points", async () => {
  const testDir = await createTempDir("shared-modules");
  
  // Copy shared modules fixture
  await copyFixture("shared-modules", testDir);
  
  // Build
  await build(testDir);
  
  const distSrcDir = path.join(testDir, "dist", "src");
  
  // Check that all entry files exist
  expect(await fileExists(path.join(distSrcDir, "entry1.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "entry2.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "shared.js"))).toBe(true);
  
  // Read the built files
  const entry1JS = await fs.readFile(path.join(distSrcDir, "entry1.js"), "utf-8");
  const entry2JS = await fs.readFile(path.join(distSrcDir, "entry2.js"), "utf-8");
  const sharedJS = await fs.readFile(path.join(distSrcDir, "shared.js"), "utf-8");
  
  // Verify that shared code is in the shared.js file
  expect(sharedJS).toContain("sharedUtility");
  expect(sharedJS).toContain("expensiveOperation");
  expect(sharedJS).toContain("SharedClass");
  
  // Verify that entry files import from shared.js instead of duplicating code
  expect(entry1JS).toContain('from "./shared.js"');
  expect(entry2JS).toContain('from "./shared.js"');
  
  // Verify that shared code is NOT duplicated in entry files
  expect(entry1JS).not.toContain("This is a shared utility function");
  expect(entry2JS).not.toContain("This is a shared utility function");
  expect(entry1JS).not.toContain("class SharedClass");
  expect(entry2JS).not.toContain("class SharedClass");
  
  // Check file sizes - entry files should be smaller than shared file
  const entry1Stats = await fs.stat(path.join(distSrcDir, "entry1.js"));
  const entry2Stats = await fs.stat(path.join(distSrcDir, "entry2.js"));
  const sharedStats = await fs.stat(path.join(distSrcDir, "shared.js"));
  
  // Shared file should be the largest since it contains the bulk of the code
  expect(sharedStats.size).toBeGreaterThan(entry1Stats.size);
  expect(sharedStats.size).toBeGreaterThan(entry2Stats.size);
  
  // Cleanup
  await removeTempDir(testDir);
});

test("shared modules work with both ESM and CJS builds", async () => {
  const testDir = await createTempDir("shared-modules-dual");
  
  // Copy shared modules fixture
  await copyFixture("shared-modules", testDir);
  
  // Build
  await build(testDir);
  
  const distSrcDir = path.join(testDir, "dist", "src");
  
  // Check that both ESM and CJS files exist
  expect(await fileExists(path.join(distSrcDir, "entry1.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "entry1.cjs"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "shared.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "shared.cjs"))).toBe(true);
  
  // Read both formats
  const entry1ESM = await fs.readFile(path.join(distSrcDir, "entry1.js"), "utf-8");
  const entry1CJS = await fs.readFile(path.join(distSrcDir, "entry1.cjs"), "utf-8");
  const sharedESM = await fs.readFile(path.join(distSrcDir, "shared.js"), "utf-8");
  const sharedCJS = await fs.readFile(path.join(distSrcDir, "shared.cjs"), "utf-8");
  
  // Verify ESM imports
  expect(entry1ESM).toContain('from "./shared.js"');
  expect(sharedESM).toContain("export");
  
  // Verify CJS requires
  expect(entry1CJS).toContain('require("./shared.cjs")');
  expect(sharedCJS).toContain("exports");
  
  // Verify no code duplication in either format
  expect(entry1ESM).not.toContain("This is a shared utility function");
  expect(entry1CJS).not.toContain("This is a shared utility function");
  
  // Cleanup
  await removeTempDir(testDir);
});