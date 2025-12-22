import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// CODE SPLITTING WITH DYNAMIC IMPORTS
// =============================================================================

test("dynamic import in src creates chunk files", async () => {
  const testDir = await createTempDir("code-splitting");

  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "code-splitting-test",
      version: "1.0.0",
      type: "module",
      private: true,
      exports: {
        ".": "./src/index.js"
      }
    }, null, 2)
  );

  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  // Main entry with dynamic import
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    `export async function loadFeature() {
  const mod = await import("./feature.js");
  return mod.feature();
}

export const version = "1.0.0";
`
  );

  // Dynamically imported module
  await FS.writeFile(
    Path.join(srcDir, "feature.ts"),
    `export function feature() {
  return "Feature loaded!";
}
`
  );

  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distSrcDir = Path.join(distDir, "src");

  // Main entry should exist
  expect(await fileExists(Path.join(distSrcDir, "index.js"))).toBe(true);

  // Check for chunk files in dist/src/_chunks/
  const chunksDir = Path.join(distSrcDir, "_chunks");
  const chunksExist = await FS.stat(chunksDir).then(() => true, () => false);
  expect(chunksExist).toBe(true);

  const chunkFiles = (await FS.readdir(chunksDir)).filter(f => f.endsWith(".js"));

  // Should have at least one chunk file for the dynamic import
  expect(chunkFiles.length).toBeGreaterThan(0);

  // Verify the main file contains import() for the chunk
  const mainContent = await FS.readFile(Path.join(distSrcDir, "index.js"), "utf-8");
  expect(mainContent).toContain("import(");

  await removeTempDir(testDir);
});

test("dynamic import in bin creates chunk files", async () => {
  const testDir = await createTempDir("bin-splitting");

  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "bin-splitting-test",
      version: "1.0.0",
      type: "module",
      private: true,
      bin: {
        "mycli": "./dist/bin/cli.js"
      }
    }, null, 2)
  );

  // Create empty src directory (required)
  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  const binDir = Path.join(testDir, "bin");
  await FS.mkdir(binDir, {recursive: true});

  // CLI with dynamic import for lazy command loading
  await FS.writeFile(
    Path.join(binDir, "cli.ts"),
    `#!/usr/bin/env node

async function main() {
  const command = process.argv[2];

  if (command === "build") {
    const {buildCommand} = await import("../src/commands/build.js");
    await buildCommand();
  } else {
    console.log("Usage: mycli build");
  }
}

main();
`
  );

  // Create the command module that will be dynamically imported
  const commandsDir = Path.join(srcDir, "commands");
  await FS.mkdir(commandsDir, {recursive: true});

  await FS.writeFile(
    Path.join(commandsDir, "build.ts"),
    `export async function buildCommand() {
  console.log("Building...");
  return "Build complete";
}
`
  );

  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distBinDir = Path.join(distDir, "bin");

  // CLI should exist
  expect(await fileExists(Path.join(distBinDir, "cli.js"))).toBe(true);

  // Check for chunk files in dist/src/_chunks/
  const distSrcDir = Path.join(distDir, "src");
  const chunksDir = Path.join(distSrcDir, "_chunks");
  const chunksExist = await FS.stat(chunksDir).then(() => true, () => false);
  expect(chunksExist).toBe(true);

  const chunkFiles = (await FS.readdir(chunksDir)).filter(f => f.endsWith(".js"));

  // Should have chunk files for the dynamic import
  expect(chunkFiles.length).toBeGreaterThan(0);

  // Verify the CLI contains dynamic import
  const cliContent = await FS.readFile(Path.join(distBinDir, "cli.js"), "utf-8");
  expect(cliContent).toContain("import(");

  await removeTempDir(testDir);
});

test("runtime execution with code splitting works", async () => {
  const testDir = await createTempDir("splitting-runtime");

  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "splitting-runtime-test",
      version: "1.0.0",
      type: "module",
      private: true,
      exports: {
        ".": "./src/index.js"
      }
    }, null, 2)
  );

  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    `export async function add(a: number, b: number) {
  const {mathUtils} = await import("./math.js");
  return mathUtils.add(a, b);
}
`
  );

  await FS.writeFile(
    Path.join(srcDir, "math.ts"),
    `export const mathUtils = {
  add(a: number, b: number) {
    return a + b;
  }
};
`
  );

  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distSrcDir = Path.join(distDir, "src");

  // Verify chunk files were created in dist/src/_chunks/
  const chunksDir = Path.join(distSrcDir, "_chunks");
  const chunksExist = await FS.stat(chunksDir).then(() => true, () => false);
  expect(chunksExist).toBe(true);

  const chunkFiles = (await FS.readdir(chunksDir)).filter(f => f.endsWith(".js"));
  expect(chunkFiles.length).toBeGreaterThan(0);

  // Test runtime execution
  const indexPath = Path.join(distSrcDir, "index.js");
  const mod = await import(indexPath);
  const result = await mod.add(2, 3);
  expect(result).toBe(5);

  await removeTempDir(testDir);
});

test("multiple dynamic imports create multiple chunks", async () => {
  const testDir = await createTempDir("multi-chunks");

  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "multi-chunks-test",
      version: "1.0.0",
      type: "module",
      private: true,
      exports: {
        ".": "./src/index.js"
      }
    }, null, 2)
  );

  const srcDir = Path.join(testDir, "src");
  await FS.mkdir(srcDir, {recursive: true});

  // Entry with multiple dynamic imports
  await FS.writeFile(
    Path.join(srcDir, "index.ts"),
    `export async function loadFeatureA() {
  const {featureA} = await import("./feature-a.js");
  return featureA();
}

export async function loadFeatureB() {
  const {featureB} = await import("./feature-b.js");
  return featureB();
}

export async function loadFeatureC() {
  const {featureC} = await import("./feature-c.js");
  return featureC();
}
`
  );

  await FS.writeFile(
    Path.join(srcDir, "feature-a.ts"),
    `export function featureA() { return "A"; }`
  );

  await FS.writeFile(
    Path.join(srcDir, "feature-b.ts"),
    `export function featureB() { return "B"; }`
  );

  await FS.writeFile(
    Path.join(srcDir, "feature-c.ts"),
    `export function featureC() { return "C"; }`
  );

  await build(testDir, false);

  const distDir = Path.join(testDir, "dist");
  const distSrcDir = Path.join(distDir, "src");

  // Check for multiple chunk files in dist/src/_chunks/
  const chunksDir = Path.join(distSrcDir, "_chunks");
  const chunksExist = await FS.stat(chunksDir).then(() => true, () => false);
  expect(chunksExist).toBe(true);

  const chunkFiles = (await FS.readdir(chunksDir)).filter(f => f.endsWith(".js"));

  // Should have multiple chunks (one for each dynamic import)
  expect(chunkFiles.length).toBeGreaterThanOrEqual(3);

  await removeTempDir(testDir);
});
