import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// Package.json Field Preservation and Transformation Tests
// =============================================================================

test("handles comprehensive package.json fields", async () => {
  const testDir = await createTempDir("comprehensive-fields");
  
  // Copy fixture
  await copyFixture("simple-lib", testDir);
  
  // Create docs directory and files for the files field pattern
  await fs.mkdir(path.join(testDir, "docs"), {recursive: true});
  await fs.writeFile(path.join(testDir, "docs", "api.md"), "# API Documentation");
  await fs.writeFile(path.join(testDir, "docs", "guide.md"), "# User Guide");
  
  // Create comprehensive package.json
  const comprehensivePkg = {
    name: "comprehensive-test",
    version: "1.0.0",
    description: "A comprehensive test package",
    keywords: ["test", "library"],
    author: "Test Author <test@example.com>",
    contributors: ["Contributor 1", "Contributor 2"],
    maintainers: ["Maintainer 1"],
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/test/comprehensive.git"
    },
    bugs: {
      url: "https://github.com/test/comprehensive/issues"
    },
    homepage: "https://github.com/test/comprehensive",
    funding: {
      type: "github",
      url: "https://github.com/sponsors/testuser"
    },
    private: true,
    type: "module",
    main: "src/index.js",
    dependencies: {
      "lodash": "^4.17.21"
    },
    peerDependencies: {
      "react": ">=16.0.0"
    },
    optionalDependencies: {
      "optional-dep": "^1.0.0"
    },
    bundledDependencies: ["bundled-dep"],
    engines: {
      node: ">=16.0.0"
    },
    cpu: ["x64"],
    os: ["linux", "darwin"],
    sideEffects: false,
    browserslist: ["> 1%", "last 2 versions"],
    files: ["src/**/*", "docs/*.md"]
  };
  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify(comprehensivePkg, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
  // Check that all fields are preserved
  expect(distPkg.description).toBe("A comprehensive test package");
  expect(distPkg.keywords).toEqual(["test", "library"]);
  expect(distPkg.author).toBe("Test Author <test@example.com>");
  expect(distPkg.contributors).toEqual(["Contributor 1", "Contributor 2"]);
  expect(distPkg.maintainers).toEqual(["Maintainer 1"]);
  expect(distPkg.license).toBe("MIT");
  expect(distPkg.repository).toEqual({
    type: "git",
    url: "https://github.com/test/comprehensive.git"
  });
  expect(distPkg.bugs).toEqual({
    url: "https://github.com/test/comprehensive/issues"
  });
  expect(distPkg.homepage).toBe("https://github.com/test/comprehensive");
  expect(distPkg.funding).toEqual({
    type: "github",
    url: "https://github.com/sponsors/testuser"
  });
  
  // Runtime fields
  expect(distPkg.dependencies).toEqual({"lodash": "^4.17.21"});
  expect(distPkg.peerDependencies).toEqual({"react": ">=16.0.0"});
  expect(distPkg.optionalDependencies).toEqual({"optional-dep": "^1.0.0"});
  expect(distPkg.bundledDependencies).toEqual(["bundled-dep"]);
  expect(distPkg.engines).toEqual({node: ">=16.0.0"});
  expect(distPkg.cpu).toEqual(["x64"]);
  expect(distPkg.os).toEqual(["linux", "darwin"]);
  expect(distPkg.sideEffects).toBe(false);
  expect(distPkg.browserslist).toEqual(["> 1%", "last 2 versions"]);
  
  // Check files field transformation
  expect(distPkg.files).toEqual(["./src/**/*", "docs/*.md"]);
  
  // Check that scripts are excluded
  expect(distPkg.scripts).toBeUndefined();
  
  // Cleanup
  await removeTempDir(testDir);
});

test("npm lifecycle scripts are preserved", async () => {
  const testDir = await createTempDir("lifecycle-scripts-test");
  
  // Create package.json with mix of scripts
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "lifecycle-scripts-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    scripts: {
      "postinstall": "echo 'after install'", // should be kept
      "preinstall": "echo 'before install'", // should be kept
      "build": "echo 'build script'", // should be removed
      "test": "echo 'test script'" // should be removed
    }
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  
  // Should only have lifecycle scripts
  expect(distPkg.scripts).toEqual({
    "postinstall": "echo 'after install'",
    "preinstall": "echo 'before install'"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

// =============================================================================
// Files Field Error Handling Tests
// =============================================================================

test("file copy error: pattern with non-existent base directory", async () => {
  const testDir = await createTempDir("copy-error-test");
  
  // Create package.json with files pattern that has non-existent base
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "copy-error-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: ["nonexistent/*.md"] // Pattern with non-existent base directory
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await expect(build(testDir, false)).rejects.toThrow('Pattern base directory not found for "nonexistent/*.md"');
  
  // Cleanup
  await removeTempDir(testDir);
});

test("file copy error: missing file in files field", async () => {
  const testDir = await createTempDir("missing-file-test");
  
  // Create package.json with files field containing non-existent file
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "missing-file-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: ["MISSING.md"] // File that doesn't exist
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await expect(build(testDir, false)).rejects.toThrow('File specified in files field not found');
  
  // Cleanup
  await removeTempDir(testDir);
});

test("files field with invalid entry type", async () => {
  const testDir = await createTempDir("invalid-files-test");
  
  // Create package.json with invalid files field entry
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-files-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: [123] // Invalid non-string entry
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await expect(build(testDir, false)).rejects.toThrow("Invalid files field entry: 123. Files field entries must be strings.");
  
  // Cleanup
  await removeTempDir(testDir);
});

// =============================================================================
// Save Behavior Tests (--save flag functionality)
// =============================================================================

test("build without --save does not modify root package.json", async () => {
  const testDir = await createTempDir("no-save-test");
  
  // Copy fixture to temporary directory to avoid modifying original
  await copyFixture("simple-lib", testDir);
  const originalPackage = await readJSON(path.join(testDir, "package.json"));
  
  // Build without save
  await build(testDir, false);
  
  // Root package.json should be unchanged
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg).toEqual(originalPackage);
  
  // Cleanup
  await removeTempDir(testDir);
});

test("build with --save updates all package.json fields correctly", async () => {
  const testDir = await createTempDir("save-test");
  
  // Copy fixture to temporary directory
  await copyFixture("multi-entry", testDir);
  
  // Build with save
  await build(testDir, true);
  
  // Check root package.json transformations
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.main).toBe("./dist/src/index.cjs");
  expect(rootPkg.module).toBe("./dist/src/index.js");
  expect(rootPkg.types).toBe("./dist/src/index.d.ts");
  
  // Check exports field is generated
  expect(rootPkg.exports).toBeDefined();
  expect(rootPkg.exports["."]).toEqual({
    types: "./dist/src/index.d.ts",
    import: "./dist/src/index.js",
    require: "./dist/src/index.cjs"
  });
  
  // Should not create files field if it didn't exist originally
  expect(rootPkg.files).toBeUndefined();
  
  // Cleanup
  await removeTempDir(testDir);
});

test("adding new entry point updates exports in subsequent --save builds", async () => {
  const testDir = await createTempDir("add-entry-test");
  
  // Copy fixture to temporary directory
  await copyFixture("simple-lib", testDir);
  
  // First build with save
  await build(testDir, true);
  
  let rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(Object.keys(rootPkg.exports)).toEqual([".", "./index", "./index.js", "./package.json"]);
  
  // Add new entry point
  await fs.writeFile(
    path.join(testDir, "src", "utils.ts"),
    'export const utils = "helper";'
  );
  
  // Build again with save
  await build(testDir, true);
  
  // Check that new entry point is in exports
  rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.exports["./utils"]).toEqual({
    types: "./dist/src/utils.d.ts",
    import: "./dist/src/utils.js", 
    require: "./dist/src/utils.cjs"
  });
  expect(rootPkg.exports["./utils.js"]).toBeDefined();
  
  // Cleanup
  await removeTempDir(testDir);
});

test("removing entry point removes it from exports in subsequent --save builds", async () => {
  const testDir = await createTempDir("remove-entry-test");
  
  // Copy fixture to avoid modifying the original
  await copyFixture("multi-entry", testDir);
  
  // Verify utils.ts was copied
  const utilsPath = path.join(testDir, "src", "utils.ts");
  if (!await fileExists(utilsPath)) {
    throw new Error(`utils.ts not found after copy: ${utilsPath}`);
  }
  
  // First build with save
  await build(testDir, true);
  
  let rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.exports["./utils"]).toBeDefined();
  expect(rootPkg.exports["./api"]).toBeDefined();
  
  // Remove utils entry point (backup first)
  const utilsBackup = await fs.readFile(utilsPath, "utf-8");
  await fs.unlink(utilsPath);
  
  // Also remove the import from index.ts and cli.ts to prevent build errors
  const indexPath = path.join(testDir, "src", "index.ts");
  const indexContent = await fs.readFile(indexPath, "utf-8");
  const indexBackup = indexContent;
  const newIndexContent = indexContent.replace("export * from './utils.js';\n", "");
  await fs.writeFile(indexPath, newIndexContent);
  
  const cliPath = path.join(testDir, "src", "cli.ts");
  const cliContent = await fs.readFile(cliPath, "utf-8");
  const cliBackup = cliContent;
  const newCliContent = cliContent.replace("import {add} from './utils.js';\n", "").replace("console.log('CLI tool result:', add(2, 3));", "console.log('CLI tool result:', 5);");
  await fs.writeFile(cliPath, newCliContent);
  
  // Also remove the utils export from package.json to simulate user removing it
  const pkgPath = path.join(testDir, "package.json");
  const pkgContent = await readJSON(pkgPath);
  const pkgBackup = JSON.stringify(pkgContent);
  if (pkgContent.exports && pkgContent.exports["./utils"]) {
    delete pkgContent.exports["./utils"];
    delete pkgContent.exports["./utils.js"];
    await fs.writeFile(pkgPath, JSON.stringify(pkgContent, null, 2));
  }
  
  // Build again with save
  await build(testDir, true);
  
  // Check that utils is removed from exports
  rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.exports["./utils"]).toBeUndefined();
  expect(rootPkg.exports["./utils.js"]).toBeUndefined();
  expect(rootPkg.exports["./api"]).toBeDefined(); // api should still be there
  
  // Cleanup
  await removeTempDir(testDir);
});

// =============================================================================
// Source Path Transformation Tests
// =============================================================================

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
    mytool: "src/cli.js",               // src/cli.js → src/cli.js (npm convention)
    helper: "src/bin/helper.ts",        // ./src/bin/helper.ts → src/bin/helper.ts (npm convention)
    processor: "src/tools/processor.js" // src/tools/processor.js → src/tools/processor.js (npm convention)
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
  expect(distPkg.bin).toBe("src/cli.js");  // src/cli.js → src/cli.js (npm convention)
  
  // Check root package.json bin transformation (no --save)
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.bin).toBe("src/cli.js");  // No transformation without --save
  
  // Cleanup
  await removeTempDir(testDir);
});
// =============================================================================
// SCOPED PACKAGE TESTS
// =============================================================================

test("scoped package handling and --access public", async () => {
  const testDir = await createTempDir("scoped-package");
  
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), `
export const scopedPackage = true;
export const version = "1.0.0";
`);
  
  // Create a scoped package
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "@test-scope/my-package",
    version: "1.0.0",
    type: "module",
    main: "dist/src/index.cjs",
    private: true
  }));
  
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
  // Should preserve scoped name
  expect(distPkg.name).toBe("@test-scope/my-package");
  
  // Should have proper exports structure
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Should have proper main/module/types fields
  expect(distPkg.main).toBe("src/index.cjs");
  expect(distPkg.module).toBe("src/index.js");
  expect(distPkg.types).toBe("src/index.d.ts");
  
  await removeTempDir(testDir);
});

test("comprehensive build verification for multi-entry project", async () => {
  const testDir = await createTempDir("comprehensive-build");
  
  await copyFixture("multi-entry", testDir);
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distSrcDir = path.join(distDir, "src");
  
  // Verify all expected files exist
  const expectedFiles = [
    "cli.js", "cli.cjs",
    "utils.js", "utils.cjs", 
    "api.js", "api.cjs",
    "index.js", "index.cjs"
  ];
  
  for (const file of expectedFiles) {
    expect(await fileExists(path.join(distSrcDir, file))).toBe(true);
  }
  
  // Verify package.json structure
  const distPkg = await readJSON(path.join(distDir, "package.json"));
  
  // Main entry exports
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Individual entry exports
  expect(distPkg.exports["./cli"]).toEqual({
    types: "./src/cli.d.ts",
    import: "./src/cli.js",
    require: "./src/cli.cjs"
  });
  
  expect(distPkg.exports["./utils"]).toEqual({
    types: "./src/utils.d.ts",
    import: "./src/utils.js",
    require: "./src/utils.cjs"
  });
  
  // Verify smart dependency resolution (no inlining between entry points)
  const cliContent = await fs.readFile(path.join(distSrcDir, "cli.js"), "utf-8");
  const utilsContent = await fs.readFile(path.join(distSrcDir, "utils.js"), "utf-8");
  
  // CLI should import from utils, not bundle it
  expect(cliContent).toContain('from "./utils.js"');
  expect(cliContent).not.toContain('function add'); // Should not contain utils code
  
  // Utils should contain the actual implementation
  expect(utilsContent).toContain('function add');
  expect(utilsContent).toContain('export');
  
  await removeTempDir(testDir);
});
