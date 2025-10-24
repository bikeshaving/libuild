import { test, expect } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { build } from "../src/libuild.ts";
import { createTempDir, removeTempDir, copyFixture, readJson, fileExists } from "./test-utils.ts";

test("ESM-only build when no main field", async () => {
  const testDir = await createTempDir("esm-only");
  
  // Create fixture without main field
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "esm-only-test",
    version: "1.0.0",
    type: "module"
    // No main field
  }, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Check that only ESM file exists
  expect(await fileExists(path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "index.cjs"))).toBe(false);
  
  // Check package.json structure
  const distPkg = await readJson(path.join(distDir, "package.json"));
  expect(distPkg.main).toBeUndefined(); // No main field
  expect(distPkg.module).toBe("src/index.js");
  expect(distPkg.types).toBe("src/index.d.ts");
  
  // Check exports structure (ESM-only)
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js"
    // No require condition
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("Dual build when main field exists", async () => {
  const testDir = await createTempDir("dual-build");
  
  // Create fixture with main field
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "dual-build-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs"
  }, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Check that both ESM and CJS files exist
  expect(await fileExists(path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "index.cjs"))).toBe(true);
  
  // Check package.json structure
  const distPkg = await readJson(path.join(distDir, "package.json"));
  expect(distPkg.main).toBe("src/index.cjs");
  expect(distPkg.module).toBe("src/index.js");
  expect(distPkg.types).toBe("src/index.d.ts");
  
  // Check exports structure (dual format)
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("Export merging preserves user-defined exports", async () => {
  const testDir = await createTempDir("export-merging");
  
  // Create fixture with existing exports
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "export-merging-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs",
    exports: {
      "./jsx-runtime": "./src/jsx-runtime.js",
      "./special-alias": "./src/utils.js"
    }
  }, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // Check that user exports are preserved and expanded
  expect(distPkg.exports["./jsx-runtime"]).toEqual({
    types: "./src/jsx-runtime.d.ts",
    import: "./src/jsx-runtime.js",
    require: "./src/jsx-runtime.cjs"
  });
  
  expect(distPkg.exports["./special-alias"]).toEqual({
    types: "./src/utils.d.ts", // Note: inferred from string path
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });
  
  // Auto-discovered entries should be added
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  expect(distPkg.exports["./utils"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("ESM-only export merging (no main field)", async () => {
  const testDir = await createTempDir("esm-export-merging");
  
  // Create fixture with existing exports but no main
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "esm-export-merging-test",
    version: "1.0.0",
    type: "module",
    // No main field
    exports: {
      "./jsx-runtime": "./src/jsx-runtime.js",
      "./special": "./src/utils.js"
    }
  }, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Check that only ESM files exist
  expect(await fileExists(path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "index.cjs"))).toBe(false);
  expect(await fileExists(path.join(distSrcDir, "utils.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "utils.cjs"))).toBe(false);
  
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // Check that user exports are preserved but NOT expanded to dual format
  expect(distPkg.exports["./jsx-runtime"]).toEqual({
    types: "./src/jsx-runtime.d.ts",
    import: "./src/jsx-runtime.js"
    // No require condition
  });
  
  expect(distPkg.exports["./special"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js"
    // No require condition
  });
  
  // Auto-discovered entries should be ESM-only
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js"
  });
  
  expect(distPkg.exports["./utils"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("Custom main entry via exports field", async () => {
  const testDir = await createTempDir("custom-main-export");
  
  // Create fixture with custom main via exports
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const index = true;');
  await fs.writeFile(path.join(testDir, "src/custom.ts"), 'export const main = "custom";');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "custom-main-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs", // Has main field for dual format
    exports: {
      ".": "./src/custom.js" // Custom main entry
    }
  }, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Check that both entries were built
  expect(await fileExists(path.join(distSrcDir, "index.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "index.cjs"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "custom.js"))).toBe(true);
  expect(await fileExists(path.join(distSrcDir, "custom.cjs"))).toBe(true);
  
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // Main should point to custom entry, not index
  expect(distPkg.main).toBe("src/custom.cjs");
  expect(distPkg.module).toBe("src/custom.js");
  expect(distPkg.types).toBe("src/custom.d.ts");
  
  // Exports should respect the custom main
  expect(distPkg.exports["."]).toEqual({
    types: "./src/custom.d.ts",
    import: "./src/custom.js",
    require: "./src/custom.cjs"
  });
  
  // Index should still be available as separate export
  expect(distPkg.exports["./index"]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("UMD build works with ESM-only mode", async () => {
  const testDir = await createTempDir("umd-esm-only");
  
  // Create fixture with UMD entry
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/umd.ts"), 'export const umd = "global";');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "umd-esm-test",
    version: "1.0.0",
    type: "module"
    // No main field = ESM-only
  }, null, 2));
  
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Check UMD file exists
  expect(await fileExists(path.join(distSrcDir, "umd.js"))).toBe(true);
  
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // UMD export should exist
  expect(distPkg.exports["./umd"]).toEqual({
    require: "./src/umd.js"
  });
  
  // Regular entries should be ESM-only
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js"
    // No require condition
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("UMD build works with dual mode", async () => {
  const testDir = await createTempDir("umd-dual");
  
  // Create fixture with UMD entry
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/umd.ts"), 'export const umd = "global";');
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "umd-dual-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs" // Has main field = dual mode
  }, null, 2));
  
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // UMD export should exist
  expect(distPkg.exports["./umd"]).toEqual({
    require: "./src/umd.js"
  });
  
  // Regular entries should be dual format
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("validates that exports only reference valid entrypoints", async () => {
  const testDir = await createTempDir("invalid-exports");
  
  // Create fixture with valid and invalid files
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await fs.writeFile(path.join(testDir, "src/_internal.ts"), 'export const internal = true;');
  
  // Test 1: Export pointing to underscore-prefixed file should crash  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-exports-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    exports: {
      "./helper": "./src/_internal.js" // Invalid - underscore prefix
    }
  }, null, 2));
  
  let errorThrown = false;
  try {
    await build(testDir);
  } catch (error: any) {
    errorThrown = true;
    console.log("Error message:", error.message);
    expect(error.message).toContain("_internal");
    expect(error.message).toContain("not a valid entrypoint");
    expect(error.message).toContain("cannot start with '_'");
  }
  expect(errorThrown).toBe(true);
  
  // Test 2: Export pointing to nested directory should crash
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-exports-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    exports: {
      "./helper": "./src/nested/deep.js" // Invalid - nested directory
    }
  }, null, 2));
  
  errorThrown = false;
  try {
    await build(testDir);
  } catch (error: any) {
    errorThrown = true;
    console.log("Error message 2:", error.message);
    expect(error.message).toContain("must point to a valid entrypoint in src/");
    expect(error.message).toContain("Nested directories");
  }
  expect(errorThrown).toBe(true);
  
  // Test 3: Valid export should work
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-exports-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    exports: {
      "./helper": "./src/utils.js" // Valid - points to valid entrypoint
    }
  }, null, 2));
  
  // Should not throw
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // Should expand properly
  expect(distPkg.exports["./helper"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("custom main entry detection", async () => {
  const testDir = await createTempDir("custom-main-test");
  
  // Copy custom-main fixture
  await copyFixture("custom-main", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check dist package.json
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // Should detect api as main entry (not index)
  expect(distPkg.main).toBe("src/api.cjs");
  expect(distPkg.module).toBe("src/api.js");
  expect(distPkg.types).toBe("src/api.d.ts");
  
  // Main export should point to api
  expect(distPkg.exports["."]).toEqual({
    types: "./src/api.d.ts",
    import: "./src/api.js",
    require: "./src/api.cjs"
  });
  
  // Should still have all entry exports
  expect(distPkg.exports["./api"]).toBeDefined();
  expect(distPkg.exports["./index"]).toBeDefined();
  expect(distPkg.exports["./utils"]).toBeDefined();
  
  // Cleanup
  await removeTempDir(testDir);
});