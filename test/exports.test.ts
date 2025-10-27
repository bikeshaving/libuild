import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// EXPORT FIELD GENERATION TESTS
// =============================================================================
test("exports field generation for multi-entry library", async () => {
  const testDir = await createTempDir("exports-test");
  
  // Copy fixture
  await copyFixture("multi-entry", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check dist package.json exports
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
  // Should have main export
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Should have individual entry exports
  expect(distPkg.exports["./api"]).toEqual({
    types: "./src/api.d.ts",
    import: "./src/api.js", 
    require: "./src/api.cjs"
  });
  
  expect(distPkg.exports["./utils"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });
  
  // Should have .js extension variants
  expect(distPkg.exports["./api.js"]).toEqual(distPkg.exports["./api"]);
  expect(distPkg.exports["./utils.js"]).toEqual(distPkg.exports["./utils"]);
  
  // Should have package.json export
  expect(distPkg.exports["./package.json"]).toBe("./package.json");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("exports field generation with --save mode", async () => {
  const testDir = await createTempDir("exports-save-test");
  
  // Copy fixture
  await copyFixture("multi-entry", testDir);
  
  // Build with --save
  await build(testDir, true);
  
  const distDir = path.join(testDir, "dist");
  
  // Check root package.json exports (should point to dist)
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  
  expect(rootPkg.exports["."]).toEqual({
    types: "./dist/src/index.d.ts",
    import: "./dist/src/index.js",
    require: "./dist/src/index.cjs"
  });
  
  expect(rootPkg.exports["./api"]).toEqual({
    types: "./dist/src/api.d.ts",
    import: "./dist/src/api.js",
    require: "./dist/src/api.cjs"
  });
  
  // Check dist package.json exports (should be relative)
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("jsx-runtime export handling", async () => {
  const testDir = await createTempDir("jsx-runtime-test");
  
  // Create package.json
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "jsx-runtime-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true
  }));
  
  // Create src directory with jsx-runtime entry
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "jsx-runtime.ts"), 'export function jsx() {}');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  
  // Should have jsx-runtime exports with dev runtime aliases
  expect(distPkg.exports["./jsx-runtime"]).toBeDefined();
  expect(distPkg.exports["./jsx-runtime.js"]).toBeDefined();
  expect(distPkg.exports["./jsx-dev-runtime"]).toBeDefined();
  expect(distPkg.exports["./jsx-dev-runtime.js"]).toBeDefined();
  
  // Cleanup
  await removeTempDir(testDir);
});

// Export validation tests
test("export expansion: invalid string export path", async () => {
  const testDir = await createTempDir("invalid-string-export");
  
  // Create package.json with invalid string export
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-string-export",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    exports: {
      "./custom": "./lib/custom.js" // doesn't match src pattern
    }
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "custom.ts"), 'export const custom = "test";');
  
  await expect(build(testDir, false)).rejects.toThrow("Export path './lib/custom.js' must point to a valid entrypoint in src/");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("export expansion: object with invalid import path", async () => {
  const testDir = await createTempDir("invalid-object-export");
  
  // Create package.json with object export having invalid import
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-object-export",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    exports: {
      "./custom": {
        import: "./lib/custom.js" // doesn't match src pattern
      }
    }
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "custom.ts"), 'export const custom = "test";');
  
  await expect(build(testDir, false)).rejects.toThrow("Export import path './lib/custom.js' must point to a valid entrypoint in src/");
  
  // Cleanup
  await removeTempDir(testDir);
});

// Export cleanup tests
test("export cleanup warns about stale exports and removes them", async () => {
  const testDir = await createTempDir("export-cleanup-warning");
  
  // Create fixture with some valid files and some stale exports
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  
  // Package.json has exports pointing to files that don't exist
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "stale-exports-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs",
    exports: {
      "./utils": "./src/utils.js",        // Valid - utils.ts exists
      "./missing": "./src/missing.js",    // Stale - missing.ts doesn't exist
      "./another": "./src/another.js",    // Stale - another.ts doesn't exist
      "./alias": "./src/utils.js"         // Valid - points to existing utils.ts
    }
  }, null, 2));
  
  // Capture console output
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const warnings: string[] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "));
  };
  
  try {
    // Build without --save (should warn but not remove from root)
    await build(testDir, false);
    
    const distDir = path.join(testDir, "dist");
    const distPkg = await readJSON(path.join(distDir, "package.json"));
    
    // Check that warnings were issued
    expect(warnings.some(w => w.includes("Found 2 stale export(s)"))).toBe(true);
    expect(warnings.some(w => w.includes("./missing"))).toBe(true);
    expect(warnings.some(w => w.includes("./another"))).toBe(true);
    expect(warnings.some(w => w.includes("Use --save to remove"))).toBe(true);
    
    // Check that dist package.json has stale exports removed
    expect(distPkg.exports["./utils"]).toBeDefined();   // Valid export preserved
    expect(distPkg.exports["./alias"]).toBeDefined();   // Valid alias preserved
    expect(distPkg.exports["./missing"]).toBeUndefined(); // Stale export removed
    expect(distPkg.exports["./another"]).toBeUndefined(); // Stale export removed
    
    // Check that root package.json still has stale exports (no --save)
    const rootPkg = await readJSON(path.join(testDir, "package.json"));
    expect(rootPkg.exports["./missing"]).toBeDefined();  // Still there in root
    expect(rootPkg.exports["./another"]).toBeDefined();  // Still there in root
    
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  
  // Cleanup
  await removeTempDir(testDir);
});

test("export cleanup with --save removes stale exports from root package.json", async () => {
  const testDir = await createTempDir("export-cleanup-save");
  
  // Create fixture with some valid files and some stale exports
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "stale-exports-save-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs",
    private: true, // Prevent warnings
    exports: {
      "./utils": "./src/utils.js",      // Valid - utils.ts exists
      "./stale": "./src/stale.js"       // Stale - stale.ts doesn't exist
    }
  }, null, 2));
  
  // Capture console output
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const warnings: string[] = [];
  const logs: string[] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "));
  };
  console.info = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  
  try {
    // Build with --save (should remove from root)
    await build(testDir, true);
    
    // Check that warnings and removal message were issued
    expect(warnings.some(w => w.includes("Found 1 stale export(s)"))).toBe(true);
    expect(warnings.some(w => w.includes("./stale"))).toBe(true);
    expect(logs.some(l => l.includes("Removing stale exports from root package.json (--save mode)"))).toBe(true);
    
    // Check that root package.json has stale exports removed
    const rootPkg = await readJSON(path.join(testDir, "package.json"));
    expect(rootPkg.exports["./utils"]).toBeDefined();   // Valid export preserved
    expect(rootPkg.exports["./stale"]).toBeUndefined(); // Stale export removed from root too
    
    // Check that dist package.json also has stale exports removed
    const distDir = path.join(testDir, "dist");
    const distPkg = await readJSON(path.join(distDir, "package.json"));
    expect(distPkg.exports["./utils"]).toBeDefined();   // Valid export preserved
    expect(distPkg.exports["./stale"]).toBeUndefined(); // Stale export removed
    
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
  }
  
  // Cleanup
  await removeTempDir(testDir);
});

test("export cleanup preserves system exports like package.json", async () => {
  const testDir = await createTempDir("export-cleanup-system");
  
  // Create fixture 
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "system-exports-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs",
    private: true,
    exports: {
      "./package.json": "./package.json",  // System export - should be preserved
      "./missing": "./src/missing.js"      // Stale export - should be removed
    }
  }, null, 2));
  
  // Build
  await build(testDir, true);
  
  // Check that system exports are preserved while stale exports are removed
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.exports["./package.json"]).toBe("./dist/package.json"); // System export preserved (points to dist in --save mode)
  expect(rootPkg.exports["./missing"]).toBeUndefined(); // Stale export removed
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  expect(distPkg.exports["./package.json"]).toBe("./package.json"); // System export preserved
  expect(distPkg.exports["./missing"]).toBeUndefined(); // Stale export removed
  
  // Cleanup
  await removeTempDir(testDir);
});

test("export cleanup handles alias exports correctly", async () => {
  const testDir = await createTempDir("export-cleanup-aliases");
  
  // Create fixture 
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src/index.ts"), 'export const hello = "world";');
  await fs.writeFile(path.join(testDir, "src/utils.ts"), 'export const utils = true;');
  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "alias-exports-test",
    version: "1.0.0",
    type: "module",
    main: "dist/index.cjs",
    private: true,
    exports: {
      "./my-utils": "./src/utils.js",     // Valid alias - utils.ts exists
      "./bad-alias": "./src/missing.js",  // Stale alias - missing.ts doesn't exist
      "./my-missing": {                   // Stale object export
        "import": "./src/missing.js",
        "types": "./src/missing.d.ts"
      },
      "./my-valid": {                     // Valid object export
        "import": "./src/utils.js",
        "types": "./src/utils.d.ts"
      }
    }
  }, null, 2));
  
  // Build
  await build(testDir, true);
  
  // Check results
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.exports["./my-utils"]).toBeDefined();   // Valid alias preserved
  expect(rootPkg.exports["./my-valid"]).toBeDefined();   // Valid object export preserved
  expect(rootPkg.exports["./bad-alias"]).toBeUndefined(); // Stale alias removed
  expect(rootPkg.exports["./my-missing"]).toBeUndefined(); // Stale object export removed
  
  // Cleanup
  await removeTempDir(testDir);
});

// Save behavior tests
test("files field behavior with --save", async () => {
  const testDir = await createTempDir("files-save-test");
  
  // Copy fixture and create a package.json with existing files field
  await copyFixture("simple-lib", testDir);
  
  // Create README.md file that's referenced in files field
  await fs.writeFile(path.join(testDir, "README.md"), "# Test Library\nA test library");
  
  const pkg = await readJSON(path.join(testDir, "package.json"));
  pkg.files = ["README.md", "src/**/*"];
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify(pkg, null, 2));
  
  // Build with --save
  await build(testDir, true);
  
  // Check root package.json
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  
  // Should contain original files plus dist/
  expect(rootPkg.files).toContain("README.md");
  expect(rootPkg.files).toContain("src/**/*");
  expect(rootPkg.files).toContain("dist/");
  
  // Should set private to true
  expect(rootPkg.private).toBe(true);
  
  // Cleanup
  await removeTempDir(testDir);
});

test("private field behavior with --save", async () => {
  const testDir = await createTempDir("private-test");
  
  // Copy fixture and make it non-private
  await copyFixture("simple-lib", testDir);
  
  const pkg = await readJSON(path.join(testDir, "package.json"));
  pkg.private = false;
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify(pkg, null, 2));
  
  // Build with --save
  await build(testDir, true);
  
  // Check that private is set to true
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.private).toBe(true);
  
  // Cleanup
  await removeTempDir(testDir);
});
// =============================================================================
// PATH MAPPING TESTS
// =============================================================================

test("path mapping fixes for dist package.json exports", async () => {
  const testDir = await createTempDir("path-mapping-fix");
  
  await copyFixture("multi-entry", testDir);
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
  // All exports should use ./src/ paths, not ./dist/src/
  for (const [key, value] of Object.entries(distPkg.exports)) {
    if (typeof value === "string") {
      if (value.includes("/src/")) {
        expect(value).toMatch(/^\.\/src\//);
        expect(value).not.toContain("./dist/src/");
      }
    } else if (typeof value === "object" && value !== null) {
      for (const [subKey, subValue] of Object.entries(value)) {
        if (typeof subValue === "string" && subValue.includes("/src/")) {
          expect(subValue).toMatch(/^\.\/src\//);
          expect(subValue).not.toContain("./dist/src/");
        }
      }
    }
  }
  
  // Specific exports should be correct
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  expect(distPkg.exports["./cli"]).toEqual({
    types: "./src/cli.d.ts",
    import: "./src/cli.js",
    require: "./src/cli.cjs"
  });
  
  await removeTempDir(testDir);
});

test("no path mapping regressions in dist package.json", async () => {
  const testDir = await createTempDir("no-regressions");
  
  await copyFixture("multi-entry", testDir);
  await build(testDir);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  
  // Should never contain ./dist/src/ paths in dist package.json
  const jsonString = JSON.stringify(distPkg);
  expect(jsonString).not.toContain("./dist/src/");
  expect(jsonString).not.toContain("dist/src/");
  
  // But should contain proper ./src/ paths
  expect(jsonString).toContain("./src/");
  
  // Verify specific problematic patterns are fixed
  expect(distPkg.main).toBe("src/index.cjs");
  expect(distPkg.module).toBe("src/index.js");
  expect(distPkg.types).toBe("src/index.d.ts");
  
  await removeTempDir(testDir);
});

test("root package.json path mapping with --save", async () => {
  const testDir = await createTempDir("root-path-mapping");
  
  await copyFixture("simple-lib", testDir);
  await build(testDir, true); // Save mode
  
  // Check root package.json has proper dist paths
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  
  // Main fields should point to dist
  expect(rootPkg.main).toBe("./dist/src/index.cjs");
  expect(rootPkg.module).toBe("./dist/src/index.js");
  expect(rootPkg.types).toBe("./dist/src/index.d.ts");
  
  // Exports should point to dist
  expect(rootPkg.exports["."]).toEqual({
    types: "./dist/src/index.d.ts",
    import: "./dist/src/index.js",
    require: "./dist/src/index.cjs"
  });
  
  // Should be marked as private
  expect(rootPkg.private).toBe(true);
  
  await removeTempDir(testDir);
});
