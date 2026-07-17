import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
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

  // Check outputs exist (flat: dist/)
  const distDir = Path.join(testDir, "dist");
  expect(await fileExists(Path.join(distDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "index.cjs"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "package.json"))).toBe(true);

  // TypeScript declarations might not be available in test environment
  const hasDts = await fileExists(Path.join(distDir, "index.d.ts"));
  if (hasDts) {
    console.log("✓ TypeScript declarations generated");
  } else {
    console.log("⚠ TypeScript declarations not available (tsc not found)");
  }

  // Check package.json structure (flat output)
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.name).toBe("simple-lib");
  expect(distPkg.main).toBe("index.cjs");
  expect(distPkg.module).toBe("index.js");
  expect(distPkg.types).toBe("index.d.ts");
  expect(distPkg.scripts).toBeUndefined(); // Scripts should be excluded

  // Check exports (flat output)
  expect(distPkg.exports["."]).toEqual({
    types: "./index.d.ts",
    import: "./index.js",
    require: "./index.cjs"
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

  const distDir = Path.join(testDir, "dist");

  // Check all entry files exist (flat output)
  const entries = ["index", "utils", "api", "cli"];
  for (const entry of entries) {
    expect(await fileExists(Path.join(distDir, `${entry}.js`))).toBe(true);
    expect(await fileExists(Path.join(distDir, `${entry}.cjs`))).toBe(true);
    // Don't require .d.ts files as tsc might not be available
  }

  // Check exports for all entries (flat output)
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["./utils"]).toEqual({
    types: "./utils.d.ts",
    import: "./utils.js",
    require: "./utils.cjs"
  });

  // Check bin transformation (flat output, npm convention)
  expect(distPkg.bin.mytool).toBe("cli.js"); // src/cli.js → cli.js (no ./ prefix)

  // Verify scripts are not copied to dist (they won't work anyway)
  expect(distPkg.scripts).toBeUndefined();
  // Private field is copied over too
  expect(distPkg.private).toBe(true);

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
  const rootPkg = await readJSON(Path.join(testDir, "package.json"));
  expect(rootPkg.main).toBe("./dist/index.cjs");
  expect(rootPkg.module).toBe("./dist/index.js");
  expect(rootPkg.types).toBe("./dist/index.d.ts");
  expect(rootPkg.bin.mytool).toBe("./dist/cli.js");

  // Check dist-prefixed exports (flat output)
  expect(rootPkg.exports["./utils"]).toEqual({
    types: "./dist/utils.d.ts",
    import: "./dist/utils.js",
    require: "./dist/utils.cjs"
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

  const distDir = Path.join(testDir, "dist");

  // Check UMD file exists (flat output)
  expect(await fileExists(Path.join(distDir, "umd.js"))).toBe(true);

  // Check UMD content contains wrapper
  const umdContent = await FS.readFile(Path.join(distDir, "umd.js"), "utf-8");
  expect(umdContent).toContain("typeof define === 'function' && define.amd");
  expect(umdContent).toContain("root.Umdlib = factory()"); // Should use capitalized package name without hyphens

  // Check package.json has UMD export (flat output)
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["./umd"]).toEqual({
    require: "./umd.js"
  });

  // Cleanup
  await removeTempDir(testDir);
});

test("UMD build works with ESM-only mode", async () => {
  const testDir = await createTempDir("umd-esm-only");

  // Create fixture with UMD entry
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await FS.writeFile(Path.join(testDir, "src/umd.ts"), 'export const umd = "global";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "umd-esm-test",
    version: "1.0.0",
    type: "module"
    // No main field = ESM-only
  }, null, 2));

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Check UMD file exists
  expect(await fileExists(Path.join(distDir, "umd.js"))).toBe(true);

  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // UMD export should exist
  expect(distPkg.exports["./umd"]).toEqual({
    require: "./umd.js"
  });

  // Regular entries should be ESM-only
  expect(distPkg.exports["."]).toEqual({
    types: "./index.d.ts",
    import: "./index.js"
    // No require condition
  });

  // Cleanup
  await removeTempDir(testDir);
});

test("UMD build works with dual mode", async () => {
  const testDir = await createTempDir("umd-dual");

  // Create fixture with UMD entry
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await FS.writeFile(Path.join(testDir, "src/umd.ts"), 'export const umd = "global";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "umd-dual-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs" // Has main field = dual mode
  }, null, 2));

  await build(testDir);

  const distDir = Path.join(testDir, "dist");
  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // UMD export should exist
  expect(distPkg.exports["./umd"]).toEqual({
    require: "./umd.js"
  });

  // Regular entries should be dual format
  expect(distPkg.exports["."]).toEqual({
    types: "./index.d.ts",
    import: "./index.js",
    require: "./index.cjs"
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
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "esm-only-test",
    version: "1.0.0",
    type: "module"
    // No main field
  }, null, 2));

  // Build
  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Check that only ESM file exists
  expect(await fileExists(Path.join(distDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "index.cjs"))).toBe(false);

  // Check package.json structure
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.main).toBeUndefined(); // No main field
  expect(distPkg.module).toBe("index.js");
  expect(distPkg.types).toBe("index.d.ts");

  // Check exports structure (ESM-only)
  expect(distPkg.exports["."]).toEqual({
    types: "./index.d.ts",
    import: "./index.js"
    // No require condition
  });

  // Cleanup
  await removeTempDir(testDir);
});

test("Dual build when main field exists", async () => {
  const testDir = await createTempDir("dual-build");

  // Create fixture with main field
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "dual-build-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs"
  }, null, 2));

  // Build
  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Check that both ESM and CJS files exist
  expect(await fileExists(Path.join(distDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "index.cjs"))).toBe(true);

  // Check package.json structure
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.main).toBe("index.cjs");
  expect(distPkg.module).toBe("index.js");
  expect(distPkg.types).toBe("index.d.ts");

  // Check exports structure (dual format)
  expect(distPkg.exports["."]).toEqual({
    types: "./index.d.ts",
    import: "./index.js",
    require: "./index.cjs"
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
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await FS.writeFile(Path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await FS.writeFile(Path.join(testDir, "src/jsx-runtime.ts"), 'export const jsx = true;');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
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

  const distDir = Path.join(testDir, "dist");
  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // Check that user exports are preserved and expanded
  expect(distPkg.exports["./jsx-runtime"]).toEqual({
    types: "./jsx-runtime.d.ts",
    import: "./jsx-runtime.js",
    require: "./jsx-runtime.cjs"
  });

  expect(distPkg.exports["./special-alias"]).toEqual({
    types: "./utils.d.ts", // Note: inferred from string path
    import: "./utils.js",
    require: "./utils.cjs"
  });

  // Auto-discovered entries should be added
  expect(distPkg.exports["."]).toEqual({
    types: "./index.d.ts",
    import: "./index.js",
    require: "./index.cjs"
  });

  expect(distPkg.exports["./utils"]).toEqual({
    types: "./utils.d.ts",
    import: "./utils.js",
    require: "./utils.cjs"
  });

  // Cleanup
  await removeTempDir(testDir);
});

test("ESM-only export merging (no main field)", async () => {
  const testDir = await createTempDir("esm-export-merging");

  // Create fixture with existing exports but no main
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await FS.writeFile(Path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await FS.writeFile(Path.join(testDir, "src/jsx-runtime.ts"), 'export const jsx = true;');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
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

  const distDir = Path.join(testDir, "dist");

  // Check that only ESM files exist
  expect(await fileExists(Path.join(distDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "index.cjs"))).toBe(false);
  expect(await fileExists(Path.join(distDir, "utils.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "utils.cjs"))).toBe(false);

  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // Check that user exports are preserved but NOT expanded to dual format
  expect(distPkg.exports["./jsx-runtime"]).toEqual({
    types: "./jsx-runtime.d.ts",
    import: "./jsx-runtime.js"
    // No require condition
  });

  expect(distPkg.exports["./special"]).toEqual({
    types: "./utils.d.ts",
    import: "./utils.js"
    // No require condition
  });

  // Auto-discovered entries should be ESM-only
  expect(distPkg.exports["."]).toEqual({
    types: "./index.d.ts",
    import: "./index.js"
  });

  expect(distPkg.exports["./utils"]).toEqual({
    types: "./utils.d.ts",
    import: "./utils.js"
  });

  // Cleanup
  await removeTempDir(testDir);
});

test("Custom main entry via exports field", async () => {
  const testDir = await createTempDir("custom-main-export");

  // Create fixture with custom main via exports
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const index = true;');
  await FS.writeFile(Path.join(testDir, "src/custom.ts"), 'export const main = "custom";');
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
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

  const distDir = Path.join(testDir, "dist");

  // Check that both entries were built
  expect(await fileExists(Path.join(distDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "index.cjs"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "custom.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "custom.cjs"))).toBe(true);

  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // Main should point to custom entry, not index
  expect(distPkg.main).toBe("custom.cjs");
  expect(distPkg.module).toBe("custom.js");
  expect(distPkg.types).toBe("custom.d.ts");

  // Exports should respect the custom main
  expect(distPkg.exports["."]).toEqual({
    types: "./custom.d.ts",
    import: "./custom.js",
    require: "./custom.cjs"
  });

  // Index should still be available as separate export
  expect(distPkg.exports["./index"]).toEqual({
    types: "./index.d.ts",
    import: "./index.js",
    require: "./index.cjs"
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

  const distDir = Path.join(testDir, "dist");

  // Check dist package.json
  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // Should detect api as main entry (not index)
  expect(distPkg.main).toBe("api.cjs");
  expect(distPkg.module).toBe("api.js");
  expect(distPkg.types).toBe("api.d.ts");

  // Main export should point to api
  expect(distPkg.exports["."]).toEqual({
    types: "./api.d.ts",
    import: "./api.js",
    require: "./api.cjs"
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
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await FS.writeFile(Path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  await FS.writeFile(Path.join(testDir, "src/_internal.ts"), 'export const internal = true;');

  // Test 1: Export pointing to underscore-prefixed file should crash
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
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
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
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
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-exports-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    exports: {
      "./helper": "./src/utils.js" // Valid - points to valid entrypoint
    }
  }, null, 2));

  // Should not throw
  await build(testDir);

  const distDir = Path.join(testDir, "dist");
  const distPkg = await readJSON(Path.join(distDir, "package.json"));

  // Should expand properly
  expect(distPkg.exports["./helper"]).toEqual({
    types: "./utils.d.ts",
    import: "./utils.js",
    require: "./utils.cjs"
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
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "main-field-test",
    version: "1.0.0",
    main: "src/api.js",
    type: "module",
    private: true
  }));

  // Create src directory with multiple entries including the main one
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "api.ts"), 'export const api = "main";');
  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  await FS.writeFile(Path.join(testDir, "src", "other.ts"), 'export const other = "helper";');

  await build(testDir, false);

  const distPkg = await readJSON(Path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("api.cjs");
  expect(distPkg.module).toBe("api.js");
  expect(distPkg.types).toBe("api.d.ts");

  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: single entry becomes main", async () => {
  const testDir = await createTempDir("single-entry-test");

  // Create package.json with main field
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "single-entry-test",
    version: "1.0.0",
    main: "dist/single.cjs",
    type: "module",
    private: true
  }));

  // Create src directory with single entry (not index)
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "single.ts"), 'export const single = "only";');

  await build(testDir, false);

  const distPkg = await readJSON(Path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("single.cjs");
  expect(distPkg.module).toBe("single.js");

  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: use package name as entry", async () => {
  const testDir = await createTempDir("pkg-name-test");

  // Create package.json with name that matches an entry
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "mylib",
    version: "1.0.0",
    main: "dist/mylib.cjs",
    type: "module",
    private: true
  }));

  // Create src directory with entry matching package name
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "mylib.ts"), 'export const mylib = "main";');
  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');

  await build(testDir, false);

  const distPkg = await readJSON(Path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("mylib.cjs");
  expect(distPkg.module).toBe("mylib.js");

  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: scoped package name", async () => {
  const testDir = await createTempDir("scoped-pkg-test");

  // Create package.json with scoped name
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "@company/mylib",
    version: "1.0.0",
    main: "dist/mylib.cjs",
    type: "module",
    private: true
  }));

  // Create src directory with entry matching package name part
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "mylib.ts"), 'export const mylib = "main";');
  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');

  await build(testDir, false);

  const distPkg = await readJSON(Path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("mylib.cjs");

  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: invalid package name error", async () => {
  const testDir = await createTempDir("invalid-name-test");

  // Create package.json with invalid name (empty after split)
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "@/",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));

  // Create src directory with entries (no index, no matching name)
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  await FS.writeFile(Path.join(testDir, "src", "other.ts"), 'export const other = "helper";');

  expect(build(testDir, false)).rejects.toThrow("Invalid package name: @/");

  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: default to first entry alphabetically", async () => {
  const testDir = await createTempDir("default-first-test");

  // Create package.json with name that doesn't match any entry
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "nomatch",
    version: "1.0.0",
    main: "dist/api.cjs",
    type: "module",
    private: true
  }));

  // Create multiple entries (no index) - should default to first alphabetically
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "zebra.ts"), 'export const zebra = "last";');
  await FS.writeFile(Path.join(testDir, "src", "api.ts"), 'export const api = "first";');
  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), 'export const utils = "middle";');

  await build(testDir, false);

  // Should use "api" as main (first alphabetically)
  const distPkg = await readJSON(Path.join(testDir, "dist", "package.json"));
  expect(distPkg.main).toBe("api.cjs");
  expect(distPkg.module).toBe("api.js");

  // Cleanup
  await removeTempDir(testDir);
});

test("main entry detection: module field", async () => {
  const testDir = await createTempDir("module-field-test");

  // Create package.json with module field (but no main field)
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "module-field-test",
    version: "1.0.0",
    module: "dist/custom.js", // Should detect "custom" as main entry
    type: "module",
    private: true
  }));

  // Create src directory with multiple entries including the one referenced by module
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const index = "index";');
  await FS.writeFile(Path.join(testDir, "src", "custom.ts"), 'export const custom = "custom main";');

  await build(testDir, false);

  // Should detect custom as main entry (from module field)
  const distPkg = await readJSON(Path.join(testDir, "dist", "package.json"));
  expect(distPkg.module).toBe("custom.js");
  expect(distPkg.types).toBe("custom.d.ts");

  // Cleanup
  await removeTempDir(testDir);
});

// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

test("build error: no src directory", async () => {
  const testDir = await createTempDir("no-src-test");

  // Create package.json but no src directory
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
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
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "no-entries-test",
    version: "1.0.0",
    type: "module"
  }));

  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});

  expect(build(testDir)).rejects.toThrow("No entry points found in src/");

  // Cleanup
  await removeTempDir(testDir);
});
// =============================================================================
// SHEBANG PRESERVATION TESTS
// =============================================================================

test("shebang preservation in CLI builds", async () => {
  const testDir = await createTempDir("shebang-preservation");

  // Create a CLI with shebang
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "cli.ts"), `#\!/usr/bin/env node

import { add } from './utils.js';
console.log("CLI result:", add(1, 2));
`);

  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), `
export function add(a: number, b: number): number {
  return a + b;
}
`);

  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "shebang-test",
    version: "1.0.0",
    type: "module",
    bin: {
      "shebang-test": "src/cli.js"
    },
    private: true
  }));

  await build(testDir);

  const distDir = Path.join(testDir, "dist");
  const cliContent = await FS.readFile(Path.join(distDir, "cli.js"), "utf-8");

  // Should have dual runtime shebang at the very beginning
  expect(cliContent.startsWith("#\!/usr/bin/env sh")).toBe(true);

  // Should have import statement (not bundled)
  expect(cliContent).toContain('from "./utils.js"');

  // Should have dual runtime detection and triple-slash reference after shebang
  const lines = cliContent.split('\n');
  const shebangLine = lines[0];
  const runtimeLine = lines[1];

  expect(shebangLine).toBe("#\!/usr/bin/env sh");
  expect(runtimeLine).toContain("':' //;");
  expect(runtimeLine).toContain("npm_config_user_agent");

  await removeTempDir(testDir);
});

test("CLI shebang with complex file structure", async () => {
  const testDir = await createTempDir("complex-cli");

  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});

  // CLI that imports from multiple files
  await FS.writeFile(Path.join(testDir, "src", "cli.ts"), `#\!/usr/bin/env node

import { version } from './version.js';
import { process } from './process.js';

console.log(\`CLI v\${version}\`);
process();
`);

  await FS.writeFile(Path.join(testDir, "src", "version.ts"), `
export const version = "1.0.0";
`);

  await FS.writeFile(Path.join(testDir, "src", "process.ts"), `
export function process() {
  console.log("Processing...");
}
`);

  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
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

  const distDir = Path.join(testDir, "dist");
  const cliContent = await FS.readFile(Path.join(distDir, "cli.js"), "utf-8");

  // Should have dual runtime shebang
  expect(cliContent.startsWith("#\!/usr/bin/env sh")).toBe(true);

  // Should import from other entry points, not bundle them
  expect(cliContent).toContain('from "./version.js"');
  expect(cliContent).toContain('from "./process.js"');

  // Should not contain the actual implementation from imported modules
  expect(cliContent).not.toContain('export const version');
  expect(cliContent).not.toContain('export function process');

  // Verify the imported files exist and contain their implementations
  const versionContent = await FS.readFile(Path.join(distDir, "version.js"), "utf-8");
  const processContent = await FS.readFile(Path.join(distDir, "process.js"), "utf-8");

  expect(versionContent).toContain('export');
  expect(versionContent).toContain('"1.0.0"');
  expect(processContent).toContain('export');
  expect(processContent).toContain('function process');

  await removeTempDir(testDir);
});

// =============================================================================
// TEST FILE IGNORING TESTS
// =============================================================================

test("ignores common test file patterns", async () => {
  const testDir = await createTempDir("test-ignore");

  // Create package.json
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "test-ignore",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs",
    private: true
  }));

  // Create src directory with various files including test patterns
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  
  // Test files that should be ignored
  await FS.writeFile(Path.join(testDir, "src", "index.test.ts"), 'test file content');
  await FS.writeFile(Path.join(testDir, "src", "utils.test.js"), 'test file content');
  await FS.writeFile(Path.join(testDir, "src", "component.spec.ts"), 'spec file content');
  await FS.writeFile(Path.join(testDir, "src", "api.spec.js"), 'spec file content');

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Check that valid entries were built
  expect(await fileExists(Path.join(distDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "utils.js"))).toBe(true);

  // Check that test files were NOT built
  expect(await fileExists(Path.join(distDir, "index.test.js"))).toBe(false);
  expect(await fileExists(Path.join(distDir, "utils.test.js"))).toBe(false);
  expect(await fileExists(Path.join(distDir, "component.spec.js"))).toBe(false);
  expect(await fileExists(Path.join(distDir, "api.spec.js"))).toBe(false);

  // Check exports - should only include valid entries
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["."]).toBeDefined();
  expect(distPkg.exports["./utils"]).toBeDefined();
  expect(distPkg.exports["./index.test"]).toBeUndefined();
  expect(distPkg.exports["./utils.test"]).toBeUndefined();
  expect(distPkg.exports["./component.spec"]).toBeUndefined();
  expect(distPkg.exports["./api.spec"]).toBeUndefined();

  await removeTempDir(testDir);
});

test("ignores test directories", async () => {
  const testDir = await createTempDir("test-dir-ignore");

  // Create package.json
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "test-dir-ignore",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs",
    private: true
  }));

  // Create src directory with valid files
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await FS.writeFile(Path.join(testDir, "src", "api.ts"), 'export const api = "api";');

  // Create test directories that should be ignored
  await FS.mkdir(Path.join(testDir, "src", "__tests__"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "__tests__", "index.test.ts"), 'test content');
  await FS.writeFile(Path.join(testDir, "src", "__tests__", "api.test.ts"), 'test content');

  await FS.mkdir(Path.join(testDir, "src", "test"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "test", "utils.test.ts"), 'test content');
  await FS.writeFile(Path.join(testDir, "src", "test", "setup.ts"), 'test setup');

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Check that valid entries were built
  expect(await fileExists(Path.join(distDir, "index.js"))).toBe(true);
  expect(await fileExists(Path.join(distDir, "api.js"))).toBe(true);

  // Check that test directories were NOT copied/processed
  expect(await fileExists(Path.join(distDir, "__tests__"))).toBe(false);
  expect(await fileExists(Path.join(distDir, "test"))).toBe(false);

  // Check exports - should only include valid entries
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["."]).toBeDefined();
  expect(distPkg.exports["./api"]).toBeDefined();
  expect(Object.keys(distPkg.exports)).toHaveLength(6); // ".", "./index", "./api", "./index.js", "./api.js", "./package.json"

  await removeTempDir(testDir);
});

test("test ignoring works with mixed valid and test files", async () => {
  const testDir = await createTempDir("mixed-files");

  // Create package.json
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "mixed-files",
    version: "1.0.0",
    type: "module",
    private: true
  }));

  // Create src directory with mixed files
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await FS.writeFile(Path.join(testDir, "src", "utils.ts"), 'export const utils = "helper";');
  await FS.writeFile(Path.join(testDir, "src", "api.ts"), 'export const api = "api";');
  
  // Test files with various patterns
  await FS.writeFile(Path.join(testDir, "src", "index.test.ts"), 'test content');
  await FS.writeFile(Path.join(testDir, "src", "utils.spec.ts"), 'spec content');
  await FS.writeFile(Path.join(testDir, "src", "integration.test.js"), 'integration test');
  await FS.writeFile(Path.join(testDir, "src", "component.spec.js"), 'component spec');

  // Files starting with underscore (already ignored)
  await FS.writeFile(Path.join(testDir, "src", "_internal.ts"), 'internal file');

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Check that only valid entries were built (3 valid files)
  const builtFiles = await FS.readdir(distDir);
  const jsFiles = builtFiles.filter(f => f.endsWith('.js'));
  
  // Should have index.js, utils.js, api.js only
  expect(jsFiles).toEqual(expect.arrayContaining(['index.js', 'utils.js', 'api.js']));
  expect(jsFiles).toHaveLength(3);

  // Check that test files were not built
  expect(jsFiles).not.toContain('index.test.js');
  expect(jsFiles).not.toContain('utils.spec.js');
  expect(jsFiles).not.toContain('integration.test.js');
  expect(jsFiles).not.toContain('component.spec.js');
  expect(jsFiles).not.toContain('_internal.js');

  // Check exports
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["."]).toBeDefined();
  expect(distPkg.exports["./utils"]).toBeDefined();
  expect(distPkg.exports["./api"]).toBeDefined();
  
  // Should not have exports for test files
  expect(distPkg.exports["./index.test"]).toBeUndefined();
  expect(distPkg.exports["./utils.spec"]).toBeUndefined();
  expect(distPkg.exports["./integration.test"]).toBeUndefined();
  expect(distPkg.exports["./component.spec"]).toBeUndefined();

  await removeTempDir(testDir);
});
