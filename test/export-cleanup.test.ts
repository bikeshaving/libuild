import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild";

// Test utility functions
async function createTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(require("os").tmpdir(), `libuild-test-${prefix}-`));
}

async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, {recursive: true, force: true});
}

async function readJSON(filePath: string): Promise<any> {
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("Export cleanup warns about stale exports and removes them", async () => {
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
  }
  
  // Cleanup
  await removeTempDir(testDir);
});

test("Export cleanup with --save removes stale exports from root package.json", async () => {
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
  const originalLog = console.log;
  const warnings: string[] = [];
  const logs: string[] = [];
  console.warn = (...args: any[]) => {
    warnings.push(args.join(" "));
  };
  console.log = (...args: any[]) => {
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
    console.log = originalLog;
  }
  
  // Cleanup
  await removeTempDir(testDir);
});

test("Export cleanup preserves system exports like package.json", async () => {
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

test("Export cleanup handles alias exports correctly", async () => {
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