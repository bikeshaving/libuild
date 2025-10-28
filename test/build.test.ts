import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// BASIC BUILD FUNCTIONALITY
// =============================================================================

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
  
  // Check bin transformation (structure-preserving, npm convention)
  expect(distPkg.bin.mytool).toBe("src/cli.js"); // src/cli.js → src/cli.js (no ./ prefix)
  
  // Verify dev scripts are filtered out (only npm lifecycle scripts preserved)
  expect(distPkg.scripts).toBeUndefined();
  
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

// =============================================================================
// UMD BUILD FUNCTIONALITY
// =============================================================================

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

test("UMD build works with ESM-only mode", async () => {
  const testDir = await createTempDir("umd-esm-only");
  
  // Create fixture with UMD entry
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
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
  
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
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
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
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
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
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

// =============================================================================
// CONDITIONAL BUILDS (ESM-ONLY VS DUAL FORMAT)
// =============================================================================

test("ESM-only build when no main field", async () => {
  const testDir = await createTempDir("esm-only");
  
  // Create fixture without main field
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
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
  const distPkg = await readJSON(path.join(distDir, "package.json"));
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
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
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
  const distPkg = await readJSON(path.join(distDir, "package.json"));
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

// =============================================================================
// EXPORT MERGING AND CUSTOM EXPORTS
// =============================================================================

test("Export merging preserves user-defined exports", async () => {
  const testDir = await createTempDir("export-merging");
  
  // Create fixture with existing exports
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await fs.writeFile(path.join(testDir, "src/jsx-runtime.ts"), 'export const jsx = true;');
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
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
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
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await fs.writeFile(path.join(testDir, "src/jsx-runtime.ts"), 'export const jsx = true;');
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
  
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
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
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
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
  
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
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

test("custom main entry detection", async () => {
  const testDir = await createTempDir("custom-main-test");
  
  // Copy custom-main fixture
  await copyFixture("custom-main", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check dist package.json
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
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

// =============================================================================
// EXPORT VALIDATION
// =============================================================================

test("validates that exports only reference valid entrypoints", async () => {
  const testDir = await createTempDir("invalid-exports");
  
  // Create fixture with valid and invalid files
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
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
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
  // Should expand properly
  expect(distPkg.exports["./helper"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

// =============================================================================
// MAIN ENTRY DETECTION TESTS
// =============================================================================

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

test("main entry detection: module field", async () => {
  const testDir = await createTempDir("module-field-test");
  
  // Create package.json with module field (but no main field)
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "module-field-test",
    version: "1.0.0",
    module: "dist/custom.js", // Should detect "custom" as main entry
    type: "module",
    private: true
  }));
  
  // Create src directory with multiple entries including the one referenced by module
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "index";');
  await fs.writeFile(path.join(testDir, "src", "custom.ts"), 'export const custom = "custom main";');
  
  await build(testDir, false);
  
  // Should detect custom as main entry (from module field)
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  expect(distPkg.module).toBe("src/custom.js");
  expect(distPkg.types).toBe("src/custom.d.ts");
  
  // Cleanup
  await removeTempDir(testDir);
});

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

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
// =============================================================================
// SHEBANG PRESERVATION TESTS
// =============================================================================

test("shebang preservation in CLI builds", async () => {
  const testDir = await createTempDir("shebang-preservation");
  
  // Create a CLI with shebang
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "cli.ts"), `#\!/usr/bin/env node

import { add } from './utils.js';
console.log("CLI result:", add(1, 2));
`);
  
  await fs.writeFile(path.join(testDir, "src", "utils.ts"), `
export function add(a: number, b: number): number {
  return a + b;
}
`);
  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "shebang-test",
    version: "1.0.0",
    type: "module",
    bin: {
      "shebang-test": "src/cli.js"
    },
    private: true
  }));
  
  await build(testDir);
  
  const distSrcDir = path.join(testDir, "dist", "src");
  const cliContent = await fs.readFile(path.join(distSrcDir, "cli.js"), "utf-8");
  
  // Should preserve shebang at the very beginning
  expect(cliContent.startsWith("#\!/usr/bin/env node")).toBe(true);
  
  // Should have import statement (not bundled)
  expect(cliContent).toContain('from "./utils.js"');
  
  // Should have triple-slash reference after shebang (if TypeScript declarations exist)
  const lines = cliContent.split('\n');
  const shebangLine = lines[0];
  const nextLine = lines[1];
  
  expect(shebangLine).toBe("#\!/usr/bin/env node");
  
  // Check if TypeScript declarations were generated
  const dtsExists = await fileExists(path.join(distSrcDir, "cli.d.ts"));
  if (dtsExists) {
    expect(nextLine).toContain("/// <reference types=");
  }
  
  await removeTempDir(testDir);
});

test("CLI shebang with complex file structure", async () => {
  const testDir = await createTempDir("complex-cli");
  
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  
  // CLI that imports from multiple files
  await fs.writeFile(path.join(testDir, "src", "cli.ts"), `#\!/usr/bin/env node

import { version } from './version.js';
import { process } from './process.js';

console.log(\`CLI v\${version}\`);
process();
`);
  
  await fs.writeFile(path.join(testDir, "src", "version.ts"), `
export const version = "1.0.0";
`);
  
  await fs.writeFile(path.join(testDir, "src", "process.ts"), `
export function process() {
  console.log("Processing...");
}
`);
  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "complex-cli",
    version: "1.0.0",
    type: "module",
    main: "dist/src/process.cjs",
    bin: {
      "complex-cli": "src/cli.js"
    },
    private: true
  }));
  
  await build(testDir);
  
  const distSrcDir = path.join(testDir, "dist", "src");
  const cliContent = await fs.readFile(path.join(distSrcDir, "cli.js"), "utf-8");
  
  // Should preserve shebang
  expect(cliContent.startsWith("#\!/usr/bin/env node")).toBe(true);
  
  // Should import from other entry points, not bundle them
  expect(cliContent).toContain('from "./version.js"');
  expect(cliContent).toContain('from "./process.js"');
  
  // Should not contain the actual implementation from imported modules
  expect(cliContent).not.toContain('export const version');
  expect(cliContent).not.toContain('export function process');
  
  // Verify the imported files exist and contain their implementations
  const versionContent = await fs.readFile(path.join(distSrcDir, "version.js"), "utf-8");
  const processContent = await fs.readFile(path.join(distSrcDir, "process.js"), "utf-8");
  
  expect(versionContent).toContain('export');
  expect(versionContent).toContain('"1.0.0"');
  expect(processContent).toContain('export');
  expect(processContent).toContain('function process');
  
  await removeTempDir(testDir);
});
