import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

test("complex bin field transformations", async () => {
  const testDir = await createTempDir("complex-bin");
  
  // Copy fixture
  await copyFixture("complex-bin", testDir);
  
  // Build with --save to test root package.json mutations
  await build(testDir, true);
  
  const distDir = path.join(testDir, "dist");
  
  // Check that all bin entries are built (structure-preserving)
  // Since there's no main field, only ESM should be generated
  const distSrcDir = path.join(distDir, "src");
  expect(await fileExists(path.join(distSrcDir, "cli.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "cli.cjs"))).toBe(false);
  
  // Check dist package.json bin transformations
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.bin).toEqual({
    mytool: "./src/cli.js",               // src/cli.js → ./src/cli.js
    helper: "./src/bin/helper.ts",        // ./src/bin/helper.ts → ./src/bin/helper.ts
    processor: "./src/tools/processor.js" // src/tools/processor.js → ./src/tools/processor.js
  });
  
  // Check root package.json bin transformations
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.bin).toEqual({
    mytool: "./dist/src/cli.js",
    helper: "./dist/src/bin/helper.ts", 
    processor: "./dist/src/tools/processor.js"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("files field src transformations", async () => {
  const testDir = await createTempDir("files-transform");
  
  // Copy fixture and modify files field
  await copyFixture("complex-bin", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check dist package.json files transformations (structure-preserving)
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.files).toEqual([
    "./src/**/*",    // src/**/* → ./src/**/*
    "docs/*.md"      // docs/*.md stays the same
  ]);
  
  // Check that docs files were actually copied
  expect(await fileExists(path.join(distDir, "docs", "test.md"))).toBe(true);
  
  // Check root package.json files field stays the same (no --save)
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.files).toEqual([
    "src/**/*",      // Original value preserved without --save
    "docs/*.md"
  ]);
  
  // Cleanup
  await removeTempDir(testDir);
});

test("dev scripts should be filtered out in dist (only npm lifecycle scripts preserved)", async () => {
  const testDir = await createTempDir("scripts-test");
  
  // Copy fixture
  await copyFixture("complex-bin", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check that dev scripts are NOT included in dist package.json (only npm lifecycle scripts)
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.scripts).toBeUndefined(); // No npm lifecycle scripts in this fixture
  
  // Check that scripts in root are NOT transformed (no --save)
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.scripts.build).toBe("src/build.js");    // No transformation without --save
  expect(rootPkg.scripts.test).toBe("node src/test.js"); // No transformation without --save
  expect(rootPkg.scripts.dev).toBe("bun src/dev.ts");    // No transformation without --save
  
  // Cleanup
  await removeTempDir(testDir);
});

test("repository field src transformations", async () => {
  const testDir = await createTempDir("repo-transform");
  
  // Copy fixture
  await copyFixture("complex-bin", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check repository transformations
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.repository).toEqual({
    type: "git",
    url: "https://github.com/test/src-project.git",  // No change to URL
    directory: "packages/src"  // Directory field not automatically transformed
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("transformSrcToDist edge cases", async () => {
  // Import the transform function directly to test edge cases
  const { transformSrcToDist } = await import("../src/libuild.ts");
  
  // Test various src patterns (structure-preserving)
  expect(transformSrcToDist("./src/file.js")).toBe("./src/file.js");
  expect(transformSrcToDist("src/file.js")).toBe("./src/file.js");
  expect(transformSrcToDist("./src")).toBe("./src");
  expect(transformSrcToDist("src")).toBe("./src");
  expect(transformSrcToDist("node src/test.js")).toBe("node src/test.js");
  expect(transformSrcToDist("path/src/file.js")).toBe("path/src/file.js");
  
  // Test non-src patterns (should remain unchanged)
  expect(transformSrcToDist("./lib/file.js")).toBe("./lib/file.js");
  expect(transformSrcToDist("dist/file.js")).toBe("dist/file.js");
  expect(transformSrcToDist("source/file.js")).toBe("source/file.js");
  
  // Test objects and arrays (structure-preserving)
  expect(transformSrcToDist({
    bin: "src/cli.js",
    scripts: { test: "node src/test.js" },
    files: ["src/**/*", "docs/*"]
  })).toEqual({
    bin: "./src/cli.js",
    scripts: { test: "node src/test.js" },
    files: ["./src/**/*", "docs/*"]
  });
  
  // Test arrays (structure-preserving)
  expect(transformSrcToDist(["src/a.js", "lib/b.js", "./src/c.js"])).toEqual([
    "./src/a.js", 
    "lib/b.js", 
    "./src/c.js"
  ]);
  
  // Test primitives
  expect(transformSrcToDist(null)).toBe(null);
  expect(transformSrcToDist(undefined)).toBe(undefined);
  expect(transformSrcToDist(42)).toBe(42);
  expect(transformSrcToDist(true)).toBe(true);
});

test("bin field with string value (not object)", async () => {
  const testDir = await createTempDir("string-bin");
  
  // Create fixture with string bin field
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/cli.ts"), '#!/usr/bin/env node\nconsole.log("CLI");');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "string-bin-test",
    version: "1.0.0",
    bin: "src/cli.js"  // String instead of object
  }, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check dist package.json bin transformation (structure-preserving)
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.bin).toBe("./src/cli.js");  // src/cli.js → ./src/cli.js
  
  // Check root package.json bin transformation (no --save)
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.bin).toBe("src/cli.js");  // No transformation without --save
  
  // Cleanup
  await removeTempDir(testDir);
});