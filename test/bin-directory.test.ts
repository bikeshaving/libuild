import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// BIN DIRECTORY FUNCTIONALITY
// =============================================================================

test("bin directory detection and build", async () => {
  const testDir = await createTempDir("bin-directory");

  // Create package.json with main field to enable CJS builds
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-bin-project",
      version: "1.0.0",
      type: "module",
      private: true,
      main: "dist/src/index.cjs"
    }, null, 2)
  );

  // Create src directory with library code
  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    'export function greet(name: string) { return `Hello, ${name}!`; }'
  );

  // Create bin directory with executable
  const binDir = Path.join(testDir, "bin");
  await FS.mkdir(binDir, {recursive: true});
  await FS.writeFile(
    Path.join(binDir, "cli.ts"),
    '#!/usr/bin/env node\nimport {greet} from "../src/index.js";\nconsole.log(greet("World"));'
  );

  // Build
  await build(testDir, false);

  // Check that both src and bin outputs exist
  const distDir = Path.join(testDir, "dist");
  const distSrcDir = Path.join(distDir, "src");
  const distBinDir = Path.join(distDir, "bin");

  // Src outputs (both ESM and CJS)
  expect(await fileExists(Path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distSrcDir, "index.cjs"))).toBe(true);
  
  // TypeScript declarations might not be available in test environment
  const hasSrcDts = await fileExists(Path.join(distSrcDir, "index.d.ts"));
  if (hasSrcDts) {
    console.log("✓ TypeScript declarations generated for src");
  } else {
    console.log("⚠ TypeScript declarations not available for src (tsc not found)");
  }

  // Bin outputs (ESM only)
  expect(await fileExists(Path.join(distBinDir, "cli.js"))).toBe(true);
  expect(await fileExists(Path.join(distBinDir, "cli.cjs"))).toBe(false); // No CJS for bin
  
  // TypeScript declarations might not be available in test environment
  const hasBinDts = await fileExists(Path.join(distBinDir, "cli.d.ts"));
  if (hasBinDts) {
    console.log("✓ TypeScript declarations generated for bin");
  } else {
    console.log("⚠ TypeScript declarations not available for bin (tsc not found)");
  }

  // Check executable permissions
  const binStat = await FS.stat(Path.join(distBinDir, "cli.js"));
  const isExecutable = (binStat.mode & 0o111) !== 0;
  expect(isExecutable).toBe(true);

  // Check package.json was generated correctly
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  
  // Should have exports for both src and bin entries
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });

  expect(distPkg.exports["./bin/cli"]).toEqual({
    types: "./bin/cli.d.ts",
    import: "./bin/cli.js"
    // No require field for bin entries
  });

  // Cleanup
  await removeTempDir(testDir);
});

test("bin directory --save updates package.json correctly", async () => {
  const testDir = await createTempDir("bin-save");

  // Create package.json with no bin field but with main for CJS
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-bin-save",
      version: "1.0.0",
      type: "module", 
      private: true,
      main: "dist/src/utils.cjs"
    }, null, 2)
  );

  // Create src and bin directories
  const srcDir = Path.join(testDir, "src");
  const binDir = Path.join(testDir, "bin");
  await FS.mkdir(srcDir, {recursive: true});
  await FS.mkdir(binDir, {recursive: true});

  await FS.writeFile(
    Path.join(srcDir, "utils.ts"),
    'export function helper() { return "helper"; }'
  );

  await FS.writeFile(
    Path.join(binDir, "tool.ts"),
    '#!/usr/bin/env node\nconsole.log("Tool running");'
  );

  // Build with --save
  await build(testDir, true);

  // Check that root package.json was updated with bin entry
  const rootPkg = await readJSON(Path.join(testDir, "package.json"));
  expect(rootPkg.bin).toEqual({
    tool: "./dist/bin/tool.js"
  });

  // Check main/module/types fields for src entries
  expect(rootPkg.main).toBe("./dist/src/utils.cjs");
  expect(rootPkg.module).toBe("./dist/src/utils.js");
  expect(rootPkg.types).toBe("./dist/src/utils.d.ts");

  // Cleanup
  await removeTempDir(testDir);
});

test("mixed src and bin entries with exports", async () => {
  const testDir = await createTempDir("mixed-entries");

  // Create package.json with main for CJS builds
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "mixed-test",
      version: "1.0.0",
      type: "module",
      private: true,
      main: "dist/src/index.cjs"
    }, null, 2)
  );

  // Create multiple src entries
  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});
  
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    'export * from "./utils.js";\nexport * from "./api.js";'
  );
  
  await FS.writeFile(
    Path.join(srcDir, "utils.ts"),
    'export function util() { return "utility"; }'
  );
  
  await FS.writeFile(
    Path.join(srcDir, "api.ts"),
    'export function api() { return "api"; }'
  );

  // Create multiple bin entries
  const binDir = Path.join(testDir, "bin");
  await FS.mkdir(binDir, {recursive: true});
  
  await FS.writeFile(
    Path.join(binDir, "cli.ts"),
    '#!/usr/bin/env node\nconsole.log("CLI tool");'
  );
  
  await FS.writeFile(
    Path.join(binDir, "helper.ts"),
    '#!/usr/bin/env node\nconsole.log("Helper tool");'
  );

  // Build
  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // Should have exports for all src entries (with CJS)
  expect(distPkg.exports["./utils"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });

  expect(distPkg.exports["./api"]).toEqual({
    types: "./src/api.d.ts", 
    import: "./src/api.js",
    require: "./src/api.cjs"
  });

  // Should have exports for all bin entries (ESM only)
  expect(distPkg.exports["./bin/cli"]).toEqual({
    types: "./bin/cli.d.ts",
    import: "./bin/cli.js"
  });

  expect(distPkg.exports["./bin/helper"]).toEqual({
    types: "./bin/helper.d.ts",
    import: "./bin/helper.js"
  });

  // Check actual files exist and have correct permissions
  const distBinDir = Path.join(distDir, "bin");
  
  // ESM files exist and are executable
  expect(await fileExists(Path.join(distBinDir, "cli.js"))).toBe(true);
  expect(await fileExists(Path.join(distBinDir, "helper.js"))).toBe(true);
  
  // No CJS files for bin
  expect(await fileExists(Path.join(distBinDir, "cli.cjs"))).toBe(false);
  expect(await fileExists(Path.join(distBinDir, "helper.cjs"))).toBe(false);

  // Check executable permissions
  const cliStat = await FS.stat(Path.join(distBinDir, "cli.js"));
  const helperStat = await FS.stat(Path.join(distBinDir, "helper.js"));
  
  expect((cliStat.mode & 0o111) !== 0).toBe(true);
  expect((helperStat.mode & 0o111) !== 0).toBe(true);

  // Cleanup
  await removeTempDir(testDir);
});

// TODO: Support bin-only projects (without src directory)
// Currently libuild requires src/ directory to exist