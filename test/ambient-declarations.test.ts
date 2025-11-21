import {test, expect, beforeEach, afterEach} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/libuild.ts";

let testDir: string;

beforeEach(async () => {
  testDir = await FS.mkdtemp("/tmp/libuild-test-");
});

afterEach(async () => {
  await FS.rm(testDir, {recursive: true, force: true});
});

test("copies ambient .d.ts files from src to dist/src", async () => {
  // Create package.json
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-ambient-dts",
      version: "0.0.1",
      type: "module",
    })
  );

  // Create src directory with TypeScript file and ambient .d.ts
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    'export function hello() { return "Hello!"; }'
  );
  await FS.writeFile(
    Path.join(testDir, "src", "global.d.ts"),
    `// Ambient declarations
declare module "*.svg" {
  const url: string;
  export default url;
}

export {};
`
  );

  // Build the project
  await build(testDir, false);

  // Verify ambient .d.ts was copied to dist/src
  const distDtsPath = Path.join(testDir, "dist", "src", "global.d.ts");
  const distDtsExists = await FS.stat(distDtsPath).then(() => true, () => false);
  expect(distDtsExists).toBe(true);

  // Verify content is identical
  const originalContent = await FS.readFile(Path.join(testDir, "src", "global.d.ts"), "utf-8");
  const copiedContent = await FS.readFile(distDtsPath, "utf-8");
  expect(copiedContent).toBe(originalContent);
});

test("copies multiple ambient .d.ts files", async () => {
  // Create package.json
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-multiple-ambient",
      version: "0.0.1",
      type: "module",
    })
  );

  // Create src directory with multiple ambient .d.ts files
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    'export function hello() { return "Hello!"; }'
  );
  await FS.writeFile(
    Path.join(testDir, "src", "assets.d.ts"),
    'declare module "*.png" { const url: string; export default url; }'
  );
  await FS.writeFile(
    Path.join(testDir, "src", "env.d.ts"),
    'declare namespace NodeJS { interface ProcessEnv { CUSTOM_VAR: string; } }'
  );

  // Build the project
  await build(testDir, false);

  // Verify both ambient .d.ts files were copied
  const assetsDtsPath = Path.join(testDir, "dist", "src", "assets.d.ts");
  const envDtsPath = Path.join(testDir, "dist", "src", "env.d.ts");

  const assetsExists = await FS.stat(assetsDtsPath).then(() => true, () => false);
  const envExists = await FS.stat(envDtsPath).then(() => true, () => false);

  expect(assetsExists).toBe(true);
  expect(envExists).toBe(true);
});

test("works correctly when no ambient .d.ts files exist", async () => {
  // Create package.json
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-no-ambient",
      version: "0.0.1",
      type: "module",
      private: true,
    })
  );

  // Create src directory with only TypeScript file (no .d.ts)
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    'export function hello() { return "Hello!"; }'
  );

  // Build should succeed
  await build(testDir, false);

  // Verify dist was created and has the generated .d.ts (not ambient)
  const distIndexDts = Path.join(testDir, "dist", "src", "index.d.ts");
  const exists = await FS.stat(distIndexDts).then(() => true, () => false);
  expect(exists).toBe(true);
});

test("works with bin-only package (empty src directory)", async () => {
  // Create package.json - bin-only packages need proper bin path
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-bin-only",
      version: "0.0.1",
      type: "module",
      private: true,
      bin: {
        "test-cli": "./dist/bin/cli.js"
      }
    })
  );

  // Create empty src directory (required) and bin directory
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.mkdir(Path.join(testDir, "bin"), {recursive: true});
  await FS.writeFile(
    Path.join(testDir, "bin", "cli.ts"),
    '#!/usr/bin/env node\nconsole.log("Hello from CLI");'
  );

  // Build should succeed
  await build(testDir, false);

  // Verify bin was built
  const distBinCli = Path.join(testDir, "dist", "bin", "cli.js");
  const exists = await FS.stat(distBinCli).then(() => true, () => false);
  expect(exists).toBe(true);
});

test("preserves ambient .d.ts with complex module declarations", async () => {
  // Create package.json
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-complex-ambient",
      version: "0.0.1",
      type: "module",
    })
  );

  // Create src directory
  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    'export function process() { return "Processing..."; }'
  );

  // Create complex ambient declaration similar to shovel's assets package
  const complexAmbient = `/**
 * TypeScript declarations for asset imports
 */

export {};

declare module "*.svg" {
  const url: string;
  export default url;
}

declare module "*.png" {
  const url: string;
  export default url;
}

declare module "*.css" {
  const url: string;
  export default url;
}

declare global {
  interface Window {
    customAPI: {
      version: string;
    };
  }
}
`;

  await FS.writeFile(
    Path.join(testDir, "src", "types.d.ts"),
    complexAmbient
  );

  // Build the project
  await build(testDir, false);

  // Verify ambient .d.ts was copied with exact content
  const distDtsPath = Path.join(testDir, "dist", "src", "types.d.ts");
  const copiedContent = await FS.readFile(distDtsPath, "utf-8");
  expect(copiedContent).toBe(complexAmbient);
});
