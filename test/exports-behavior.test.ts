import { test, expect } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { build } from "../src/libuild.ts";
import { createTempDir, removeTempDir, copyFixture, readJson, fileExists } from "./test-utils.ts";

test("exports field generation for multi-entry library", async () => {
  const testDir = await createTempDir("exports-test");
  
  // Copy fixture
  await copyFixture("multi-entry", testDir);
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  
  // Check dist package.json exports
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
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
  const rootPkg = await readJson(path.join(testDir, "package.json"));
  
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
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  expect(distPkg.exports["."]).toEqual({
    types: "./src/index.d.ts",
    import: "./src/index.js",
    require: "./src/index.cjs"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("files field behavior with --save", async () => {
  const testDir = await createTempDir("files-save-test");
  
  // Copy fixture and create a package.json with existing files field
  await copyFixture("simple-lib", testDir);
  
  // Create README.md file that's referenced in files field
  await fs.writeFile(path.join(testDir, "README.md"), "# Test Library\nA test library");
  
  const pkg = await readJson(path.join(testDir, "package.json"));
  pkg.files = ["README.md", "src/**/*"];
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify(pkg, null, 2));
  
  // Build with --save
  await build(testDir, true);
  
  // Check root package.json
  const rootPkg = await readJson(path.join(testDir, "package.json"));
  
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
  
  const pkg = await readJson(path.join(testDir, "package.json"));
  pkg.private = false;
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify(pkg, null, 2));
  
  // Build with --save
  await build(testDir, true);
  
  // Check that private is set to true
  const rootPkg = await readJson(path.join(testDir, "package.json"));
  expect(rootPkg.private).toBe(true);
  
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
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "jsx-runtime.ts"), 'export function jsx() {}');
  
  await build(testDir, false);
  
  const distPkg = await readJson(path.join(testDir, "dist", "package.json"));
  
  // Should have jsx-runtime exports with dev runtime aliases
  expect(distPkg.exports["./jsx-runtime"]).toBeDefined();
  expect(distPkg.exports["./jsx-runtime.js"]).toBeDefined();
  expect(distPkg.exports["./jsx-dev-runtime"]).toBeDefined();
  expect(distPkg.exports["./jsx-dev-runtime.js"]).toBeDefined();
  
  // Cleanup
  await removeTempDir(testDir);
});

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
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
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
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "custom.ts"), 'export const custom = "test";');
  
  await expect(build(testDir, false)).rejects.toThrow("Export import path './lib/custom.js' must point to a valid entrypoint in src/");
  
  // Cleanup
  await removeTempDir(testDir);
});