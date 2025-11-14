import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// TOP-LEVEL AWAIT SUPPORT TESTS
// =============================================================================

test("TLA gracefully disables CJS generation", async () => {
  const testDir = await createTempDir("tla-graceful");

  // Create package.json with main field (would normally trigger CJS)
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "tla-test",
      version: "1.0.0",
      type: "module",
      private: true,
      main: "dist/src/index.cjs"  // This should be ignored due to TLA
    }, null, 2)
  );

  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  // Create a file with top-level await
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    `// Module with top-level await
const config = await fetch("https://example.com/config.json").then(r => r.json());
export const data = config;
`
  );

  // Build should succeed but skip CJS
  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distSrcDir = Path.join(distDir, "src");

  // ESM file should exist
  expect(await fileExists(Path.join(distSrcDir, "index.js"))).toBe(true);

  // CJS file should NOT exist (disabled due to TLA)
  expect(await fileExists(Path.join(distSrcDir, "index.cjs"))).toBe(false);

  // Check package.json was generated without CJS/require fields
  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // Should have ESM export only
  expect(distPkg.exports["."]).toBeDefined();
  expect(distPkg.exports["."].import).toBe("./src/index.js");
  expect(distPkg.exports["."].require).toBeUndefined(); // No require field

  // Should not have main field
  expect(distPkg.main).toBeUndefined();

  await removeTempDir(testDir);
});

test("TLA in some files disables all CJS generation", async () => {
  const testDir = await createTempDir("tla-mixed");

  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "tla-mixed-test",
      version: "1.0.0",
      type: "module",
      private: true,
      main: "dist/src/index.cjs"
    }, null, 2)
  );

  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  // File without TLA
  await FS.writeFile(
    Path.join(srcDir, "utils.ts"),
    'export function helper() { return "helper"; }'
  );

  // File WITH TLA
  await FS.writeFile(
    Path.join(srcDir, "async-config.ts"),
    'export const config = await Promise.resolve({key: "value"});'
  );

  // Main file importing both
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    'export * from "./utils.js";\nexport * from "./async-config.js";'
  );

  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distSrcDir = Path.join(distDir, "src");

  // ESM files should exist
  expect(await fileExists(Path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distSrcDir, "utils.js"))).toBe(true);
  expect(await fileExists(Path.join(distSrcDir, "async-config.js"))).toBe(true);

  // NO CJS files should exist (TLA in one file disables all CJS)
  expect(await fileExists(Path.join(distSrcDir, "index.cjs"))).toBe(false);
  expect(await fileExists(Path.join(distSrcDir, "utils.cjs"))).toBe(false);
  expect(await fileExists(Path.join(distSrcDir, "async-config.cjs"))).toBe(false);

  // Check exports don't have require fields
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["."].require).toBeUndefined();
  expect(distPkg.exports["./utils"]?.require).toBeUndefined();
  expect(distPkg.exports["./async-config"]?.require).toBeUndefined();

  await removeTempDir(testDir);
});

test("TLA with --save doesn't add main field", async () => {
  const testDir = await createTempDir("tla-save");

  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "tla-save-test",
      version: "1.0.0",
      type: "module",
      private: true
      // No main field initially
    }, null, 2)
  );

  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  // File with TLA
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    'export const data = await Promise.resolve("async data");'
  );

  // Build with --save
  await build(testDir, true);

  // Check root package.json was NOT updated with main field
  const rootPkg = await readJSON(Path.join(testDir, "package.json"));
  expect(rootPkg.main).toBeUndefined();

  // Should have module and types for ESM
  expect(rootPkg.module).toBe("./dist/src/index.js");
  expect(rootPkg.types).toBe("./dist/src/index.d.ts");

  await removeTempDir(testDir);
});

test("Non-TLA project still generates CJS normally", async () => {
  const testDir = await createTempDir("no-tla");

  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "no-tla-test",
      version: "1.0.0",
      type: "module",
      private: true,
      main: "dist/src/index.cjs"
    }, null, 2)
  );

  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  // Regular synchronous code
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    'export function greet(name: string) { return `Hello, ${name}!`; }'
  );

  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distSrcDir = Path.join(distDir, "src");

  // Both ESM and CJS should exist
  expect(await fileExists(Path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distSrcDir, "index.cjs"))).toBe(true);

  // Check package.json has both import and require
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["."].import).toBe("./src/index.js");
  expect(distPkg.exports["."].require).toBe("./src/index.cjs");
  expect(distPkg.main).toBe("src/index.cjs");

  await removeTempDir(testDir);
});
