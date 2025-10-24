import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

test("simple library build", async () => {
  const testDir = await createTempDir("simple-lib");
  
  // Copy fixture
  await copyFixture("simple-lib", testDir);
  
  // Build
  await build(testDir);
  
  // Check outputs exist (structure-preserving: dist/src/)
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  expect(await fileExists(path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "index.cjs"))).toBe(true);
  expect(await fileExists(path.join(distDir, "package.json"))).toBe(true);
  
  // TypeScript declarations might not be available in test environment
  const hasDts = await fileExists(path.join(distSrcDir, "index.d.ts"));
  if (hasDts) {
    console.log("✓ TypeScript declarations generated");
  } else {
    console.log("⚠ TypeScript declarations not available (tsc not found)");
  }
  
  // Check package.json structure (structure-preserving)
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.name).toBe("simple-lib");
  expect(distPkg.main).toBe("src/index.cjs");
  expect(distPkg.module).toBe("src/index.js");
  expect(distPkg.types).toBe("src/index.d.ts");
  expect(distPkg.scripts).toBeUndefined(); // Scripts should be excluded
  
  // Check exports (structure-preserving)
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("multi-entry library build", async () => {
  const testDir = await createTempDir("multi-entry");
  
  // Copy fixture
  await copyFixture("multi-entry", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Check all entry files exist (structure-preserving)
  const entries = ["index", "utils", "api", "cli"];
  for (const entry of entries) {
    expect(await fileExists(path.join(distSrcDir, `${entry}.js`))).toBe(true);
    expect(await fileExists(path.join(distSrcDir, `${entry}.cjs`))).toBe(true);
    // Don't require .d.ts files as tsc might not be available
  }
  
  // Check exports for all entries (structure-preserving)
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.exports["./utils"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });
  
  // Check bin transformation (structure-preserving)
  expect(distPkg.bin.mytool).toBe("./src/cli.js"); // src/cli.js → ./src/cli.js
  
  // Verify dev scripts are filtered out (only npm lifecycle scripts preserved)
  expect(distPkg.scripts).toBeUndefined();
  
  // Cleanup
  await removeTempDir(testDir);
});

test("UMD build", async () => {
  const testDir = await createTempDir("with-umd");
  
  // Copy fixture
  await copyFixture("with-umd", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Check UMD file exists (structure-preserving)
  expect(await fileExists(path.join(distSrcDir, "umd.js"))).toBe(true);
  
  // Check UMD content contains wrapper
  const umdContent = await fs.readFile(path.join(distSrcDir, "umd.js"), "utf-8");
  expect(umdContent).toContain("typeof define === 'function' && define.amd");
  expect(umdContent).toContain("root.Umdlib = factory()"); // Should use capitalized package name without hyphens
  
  // Check package.json has UMD export (structure-preserving)
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.exports["./umd"]).toEqual({
    require: "./src/umd.js"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("root package.json is updated correctly", async () => {
  const testDir = await createTempDir("root-pkg-test");
  
  // Copy fixture
  await copyFixture("multi-entry", testDir);
  
  // Build with --save flag to update root package.json
  await build(testDir, true);
  
  // Check root package.json was updated (structure-preserving with --save)
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.main).toBe("./dist/src/index.cjs");
  expect(rootPkg.module).toBe("./dist/src/index.js");
  expect(rootPkg.types).toBe("./dist/src/index.d.ts");
  expect(rootPkg.bin.mytool).toBe("./dist/src/cli.js");
  
  // Check dist-prefixed exports (structure-preserving)
  expect(rootPkg.exports["./utils"]).toEqual({
    types: "./dist/src/utils.d.ts",
    import: "./dist/src/utils.js",
    require: "./dist/src/utils.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("build error: no src directory", async () => {
  const testDir = await createTempDir("no-src-test");
  
  // Create package.json but no src directory
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "no-src-test",
    version: "1.0.0",
    type: "module"
  }));
  
  await expect(build(testDir)).rejects.toThrow("No src/ directory found");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("build error: no entry points found", async () => {
  const testDir = await createTempDir("no-entries-test");
  
  // Create package.json and empty src directory
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "no-entries-test",
    version: "1.0.0",
    type: "module"
  }));
  
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  
  await expect(build(testDir)).rejects.toThrow("No entry points found in src/");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: package.json main field", async () => {
  const testDir = await createTempDir("main-field-test");
  
  // Create package.json with main field pointing to specific entry
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "main-field-test",
    version: "1.0.0",
    main: "src/api.js",
    type: "module",
    private: true
  }));
  
  // Create src directory with multiple entries including the main one
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "api.ts"), 'export const api = "main";');
  await fs.writeFile(path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  await fs.writeFile(path.join(testDir, "src", "other.ts"), 'export const other = "helper";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("src/api.cjs");
  expect(distPkg.module).toBe("src/api.js");
  expect(distPkg.types).toBe("src/api.d.ts");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: single entry becomes main", async () => {
  const testDir = await createTempDir("single-entry-test");
  
  // Create package.json with main field
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "single-entry-test",
    version: "1.0.0",
    main: "dist/single.cjs",
    type: "module",
    private: true
  }));
  
  // Create src directory with single entry (not index)
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "single.ts"), 'export const single = "only";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("src/single.cjs");
  expect(distPkg.module).toBe("src/single.js");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: use package name as entry", async () => {
  const testDir = await createTempDir("pkg-name-test");
  
  // Create package.json with name that matches an entry
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "mylib",
    version: "1.0.0",
    main: "dist/mylib.cjs",
    type: "module",
    private: true
  }));
  
  // Create src directory with entry matching package name
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "mylib.ts"), 'export const mylib = "main";');
  await fs.writeFile(path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("src/mylib.cjs");
  expect(distPkg.module).toBe("src/mylib.js");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: scoped package name", async () => {
  const testDir = await createTempDir("scoped-pkg-test");
  
  // Create package.json with scoped name
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "@company/mylib",
    version: "1.0.0",
    main: "dist/mylib.cjs",
    type: "module",
    private: true
  }));
  
  // Create src directory with entry matching package name part
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "mylib.ts"), 'export const mylib = "main";');
  await fs.writeFile(path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("src/mylib.cjs");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: invalid package name error", async () => {
  const testDir = await createTempDir("invalid-name-test");
  
  // Create package.json with invalid name (empty after split)
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "@/",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));
  
  // Create src directory with entries (no index, no matching name)
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  await fs.writeFile(path.join(testDir, "src", "other.ts"), 'export const other = "helper";');
  
  await expect(build(testDir, false)).rejects.toThrow("Invalid package name: @/");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: default to first entry alphabetically", async () => {
  const testDir = await createTempDir("default-first-test");
  
  // Create package.json with name that doesn't match any entry  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "nomatch",
    version: "1.0.0",
    main: "dist/api.cjs",
    type: "module",
    private: true
  }));
  
  // Create multiple entries (no index) - should default to first alphabetically
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "zebra.ts"), 'export const zebra = "last";');
  await fs.writeFile(path.join(testDir, "src", "api.ts"), 'export const api = "first";');
  await fs.writeFile(path.join(testDir, "src", "utils.ts"), 'export const utils = "middle";');
  
  await build(testDir, false);
  
  // Should use "api" as main (first alphabetically)
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("src/api.cjs");
  expect(distPkg.module).toBe("src/api.js");
  
  // Cleanup
  await removeTempDir(testDir);
});