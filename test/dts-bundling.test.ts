import {test, expect, beforeEach, afterEach} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/libuild.ts";

let testDir: string;

beforeEach(async () => {
  testDir = await FS.mkdtemp("/tmp/libuild-test-dts-");
});

afterEach(async () => {
  await FS.rm(testDir, {recursive: true, force: true});
});

test("generates .d.ts files for internal modules", async () => {
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-internal-dts",
      version: "0.0.1",
      type: "module",
    })
  );

  // Create src with internal module
  await FS.mkdir(Path.join(testDir, "src", "impl"), {recursive: true});

  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    `export { helper } from "./impl/utils.js";
export function main() { return "main"; }`
  );

  await FS.writeFile(
    Path.join(testDir, "src", "impl", "utils.ts"),
    `export function helper() { return "helper"; }`
  );

  await build(testDir, false);

  // Check that impl directory exists with .d.ts
  const implDtsPath = Path.join(testDir, "dist", "src", "impl", "utils.d.ts");
  const implDtsExists = await FS.stat(implDtsPath).then(() => true, () => false);
  expect(implDtsExists).toBe(true);

  // Check index.d.ts references impl
  const indexDts = await FS.readFile(Path.join(testDir, "dist", "src", "index.d.ts"), "utf-8");
  expect(indexDts).toContain("./impl/utils.js");
});

test("includes module augmentation in generated .d.ts", async () => {
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-module-augmentation",
      version: "0.0.1",
      type: "module",
    })
  );

  await FS.mkdir(Path.join(testDir, "src", "impl"), {recursive: true});

  // Entry point that re-exports from impl
  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    `export { extendFoo } from "./impl/augment.js";`
  );

  // Internal module with module augmentation
  await FS.writeFile(
    Path.join(testDir, "src", "impl", "augment.ts"),
    `
export function extendFoo() {}

// Module augmentation for a hypothetical external module
declare module "some-external-lib" {
  interface SomeType {
    extended: boolean;
  }
}
`
  );

  await build(testDir, false);

  // Check that augmentation is in the generated .d.ts
  const augmentDts = await FS.readFile(
    Path.join(testDir, "dist", "src", "impl", "augment.d.ts"),
    "utf-8"
  );
  expect(augmentDts).toContain('declare module "some-external-lib"');
  expect(augmentDts).toContain("extended: boolean");
});

test("generates .d.ts for deeply nested modules", async () => {
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-nested-dts",
      version: "0.0.1",
      type: "module",
    })
  );

  await FS.mkdir(Path.join(testDir, "src", "a", "b", "c"), {recursive: true});

  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    `export { levelA } from "./a/level-a.js";`
  );

  await FS.writeFile(
    Path.join(testDir, "src", "a", "level-a.ts"),
    `export { levelB } from "./b/level-b.js";
export function levelA() { return "a"; }`
  );

  await FS.writeFile(
    Path.join(testDir, "src", "a", "b", "level-b.ts"),
    `export { levelC } from "./c/level-c.js";
export function levelB() { return "b"; }`
  );

  await FS.writeFile(
    Path.join(testDir, "src", "a", "b", "c", "level-c.ts"),
    `export function levelC() { return "c"; }`
  );

  await build(testDir, false);

  // Check all .d.ts files exist
  const paths = [
    "dist/src/index.d.ts",
    "dist/src/a/level-a.d.ts",
    "dist/src/a/b/level-b.d.ts",
    "dist/src/a/b/c/level-c.d.ts",
  ];

  for (const p of paths) {
    const exists = await FS.stat(Path.join(testDir, p)).then(() => true, () => false);
    expect(exists).toBe(true);
  }
});

test("handles multiple entry points with shared internal modules", async () => {
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-multi-entry-dts",
      version: "0.0.1",
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./utils": "./src/utils.ts",
      },
    })
  );

  await FS.mkdir(Path.join(testDir, "src", "shared"), {recursive: true});

  // Both entry points use shared module
  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    `export { shared } from "./shared/common.js";
export function main() { return "main"; }`
  );

  await FS.writeFile(
    Path.join(testDir, "src", "utils.ts"),
    `export { shared } from "./shared/common.js";
export function utils() { return "utils"; }`
  );

  await FS.writeFile(
    Path.join(testDir, "src", "shared", "common.ts"),
    `export function shared() { return "shared"; }`
  );

  await build(testDir, false);

  // Check both entries and shared module have .d.ts
  const indexDts = await FS.readFile(Path.join(testDir, "dist", "src", "index.d.ts"), "utf-8");
  const utilsDts = await FS.readFile(Path.join(testDir, "dist", "src", "utils.d.ts"), "utf-8");
  const sharedDts = await FS.readFile(Path.join(testDir, "dist", "src", "shared", "common.d.ts"), "utf-8");

  expect(indexDts).toContain("./shared/common.js");
  expect(utilsDts).toContain("./shared/common.js");
  expect(sharedDts).toContain("export declare function shared");
});

test("preserves declare global in generated .d.ts", async () => {
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-declare-global",
      version: "0.0.1",
      type: "module",
    })
  );

  await FS.mkdir(Path.join(testDir, "src", "impl"), {recursive: true});

  await FS.writeFile(
    Path.join(testDir, "src", "index.ts"),
    `export { setup } from "./impl/globals.js";`
  );

  await FS.writeFile(
    Path.join(testDir, "src", "impl", "globals.ts"),
    `
export function setup() {}

declare global {
  interface Window {
    myLib: {
      version: string;
    };
  }
}
`
  );

  await build(testDir, false);

  const globalsDts = await FS.readFile(
    Path.join(testDir, "dist", "src", "impl", "globals.d.ts"),
    "utf-8"
  );
  expect(globalsDts).toContain("declare global");
  expect(globalsDts).toContain("myLib");
});

test("bin importing from src does not emit .d.ts to src directory", async () => {
  await FS.writeFile(
    Path.join(testDir, "package.json"),
    JSON.stringify({
      name: "test-bin-imports-src",
      version: "0.0.1",
      type: "module",
      bin: {
        "mycli": "./bin/cli.js"
      }
    })
  );

  // Create bin and src directories
  await FS.mkdir(Path.join(testDir, "bin"), {recursive: true});
  await FS.mkdir(Path.join(testDir, "src", "utils"), {recursive: true});

  // CLI that imports from src
  await FS.writeFile(
    Path.join(testDir, "bin", "cli.ts"),
    `#!/usr/bin/env node
import { helper } from "../src/utils/helper.js";
console.log(helper());
`
  );

  // Src utility file
  await FS.writeFile(
    Path.join(testDir, "src", "utils", "helper.ts"),
    `export function helper() { return "helper"; }`
  );

  await build(testDir, false);

  // .d.ts should NOT be emitted to src directory
  const srcDtsExists = await FS.stat(
    Path.join(testDir, "src", "utils", "helper.d.ts")
  ).then(() => true, () => false);
  expect(srcDtsExists).toBe(false);

  // bin .d.ts should exist in dist
  const binDtsExists = await FS.stat(
    Path.join(testDir, "dist", "bin", "cli.d.ts")
  ).then(() => true, () => false);
  expect(binDtsExists).toBe(true);
});
