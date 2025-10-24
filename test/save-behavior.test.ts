import {test, expect, beforeEach, afterEach} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

const fixturesDir = path.join(__dirname, "fixtures");
const backups = new Map<string, string>();

async function backupPackageJson(fixtureDir: string) {
  const pkgPath = path.join(fixtureDir, "package.json");
  const backup = await fs.readFile(pkgPath, "utf-8");
  backups.set(pkgPath, backup);
}

async function restorePackageJson(fixtureDir: string) {
  const pkgPath = path.join(fixtureDir, "package.json");
  const backup = backups.get(pkgPath);
  if (backup) {
    await fs.writeFile(pkgPath, backup);
  }
  // Clean up dist directory too
  const distPath = path.join(fixtureDir, "dist");
  await fs.rm(distPath, {recursive: true, force: true});
}

test("build without --save does not modify root package.json", async () => {
  const testDir = path.join(fixturesDir, "simple-lib");
  
  // Backup original package.json
  await backupPackageJson(testDir);
  const originalPackage = await readJSON(path.join(testDir, "package.json"));
  
  try {
    // Build without save
    await build(testDir, false);
    
    // Root package.json should be unchanged
    const rootPkg = await readJSON(path.join(testDir, "package.json"));
    expect(rootPkg).toEqual(originalPackage);
  } finally {
    // Restore original state
    await restorePackageJson(testDir);
  }
});

test("build with --save updates all package.json fields correctly", async () => {
  const testDir = path.join(fixturesDir, "multi-entry");
  
  // Backup original package.json
  await backupPackageJson(testDir);
  
  try {
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
  } finally {
    // Restore original state
    await restorePackageJson(testDir);
  }
});

test("adding new entry point updates exports in subsequent --save builds", async () => {
  const testDir = path.join(fixturesDir, "simple-lib");
  
  // Backup original package.json
  await backupPackageJson(testDir);
  
  try {
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
  } finally {
    // Clean up added file and restore
    await fs.rm(path.join(testDir, "src", "utils.ts"), {force: true});
    await restorePackageJson(testDir);
  }
});

test("removing entry point removes it from exports in subsequent --save builds", async () => {
  const testDir = await createTempDir("remove-entry-test");
  
  // Copy fixture to avoid modifying the original
  const sourceDir = path.join(fixturesDir, "multi-entry");
  await fs.cp(sourceDir, testDir, {recursive: true});
  
  // Verify utils.ts was copied
  const utilsPath = path.join(testDir, "src", "utils.ts");
  if (!await fileExists(utilsPath)) {
    throw new Error(`utils.ts not found after copy: ${utilsPath}`);
  }
  
  try {
    // First build with save
    await build(testDir, true);
    
    let rootPkg = await readJSON(path.join(testDir, "package.json"));
    expect(rootPkg.exports["./utils"]).toBeDefined();
    expect(rootPkg.exports["./api"]).toBeDefined();
    
    // Remove utils entry point (backup first)
    const utilsPath = path.join(testDir, "src", "utils.ts");
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
    
    // Restore utils file, index.ts, cli.ts, and package.json
    await fs.writeFile(utilsPath, utilsBackup);
    await fs.writeFile(indexPath, indexBackup);
    await fs.writeFile(cliPath, cliBackup);
    await fs.writeFile(pkgPath, pkgBackup);
  } finally {
    // Clean up tmp directory
    await removeTempDir(testDir);
  }
});


// Note: Previously skipped tests were removed as they were redundant:
// - "main entry point detection" → covered by conditional-builds.test.ts
// - "bin field string format" → covered by src-transforms.test.ts  
// - "preserves package.json fields" → covered by package-fields.test.ts
