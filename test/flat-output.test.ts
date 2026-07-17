import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// FLAT OUTPUT LAYOUT (#9)
//
// Modules publish at the tarball root (dist/<entry>.js) instead of dist/src/.
// Clean break: no src/ directory ships at all - direct CDN URLs use the root
// paths (<pkg>/index.js), and the old <pkg>/src/ paths 404 after republish.
// =============================================================================

test("flat layout: modules at root, no src/ directory in output", async () => {
  const testDir = await createTempDir("flat-layout");
  await copyFixture("multi-entry", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Real modules at the dist root
  for (const entry of ["index", "utils", "api", "cli"]) {
    expect(await fileExists(Path.join(distDir, `${entry}.js`))).toBe(true);
    expect(await fileExists(Path.join(distDir, `${entry}.cjs`))).toBe(true);
  }

  // The src/ wrapper is gone entirely
  expect(await fileExists(Path.join(distDir, "src"))).toBe(false);

  const realJs = await FS.readFile(Path.join(distDir, "utils.js"), "utf-8");
  expect(realJs).toContain("function add");

  // Package.json points at the root paths
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.module).toBe("index.js");
  expect(distPkg.exports["."].import).toBe("./index.js");
  expect(distPkg.exports["./utils"].import).toBe("./utils.js");

  await removeTempDir(testDir);
});

test("flat layout: root modules resolve at runtime (CDN-literal simulation)", async () => {
  const testDir = await createTempDir("flat-runtime");
  await copyFixture("multi-entry", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // A literal file lookup at the root - what jsDelivr/unpkg do for
  // <pkg>/utils.js - resolves and works
  const esm = await import(Path.join(distDir, "utils.js"));
  expect(esm.add(2, 3)).toBe(5);

  await removeTempDir(testDir);
});

test("flat layout: internal-module .d.ts and augmentations relocate together (#1 guard)", async () => {
  const testDir = await createTempDir("flat-augmentation");
  await copyFixture("flat-augmentation", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // TypeScript may be unavailable in some environments - skip like other tests do
  if (!await fileExists(Path.join(distDir, "index.d.ts"))) {
    console.log("⚠ TypeScript declarations not available (tsc not found)");
    await removeTempDir(testDir);
    return;
  }

  // The whole tree relocated together: entry .d.ts at root still imports the
  // internal module by the SAME relative path, and that module's .d.ts exists
  const indexDts = await FS.readFile(Path.join(distDir, "index.d.ts"), "utf-8");
  expect(indexDts).toContain('"./impl/table.js"');
  expect(await fileExists(Path.join(distDir, "impl", "table.d.ts"))).toBe(true);

  // The module augmentation survives in the published declarations
  const tableDts = await FS.readFile(Path.join(distDir, "impl", "table.d.ts"), "utf-8");
  expect(tableDts).toContain('declare module "node:events"');

  await removeTempDir(testDir);
});

test("flat layout: UMD builds to root, siblings not wrapped", async () => {
  const testDir = await createTempDir("flat-umd");
  await copyFixture("with-umd", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // UMD at the root, wrapped
  const umd = await FS.readFile(Path.join(distDir, "umd.js"), "utf-8");
  expect(umd).toContain("typeof define === 'function' && define.amd");

  // Regression: the UMD pass must not wrap sibling entry files
  // (on main, every .js in the UMD outdir was wrapped and corrupted)
  const index = await FS.readFile(Path.join(distDir, "index.js"), "utf-8");
  expect(index).not.toContain("define.amd");
  expect(index).toContain("export");

  await removeTempDir(testDir);
});

test("flat layout: --save root bin points at the flat executable", async () => {
  const testDir = await createTempDir("flat-save-bin");
  await copyFixture("multi-entry", testDir);

  await build(testDir, true); // --save

  // Author bin was "src/cli.js"; the flat dist location is dist/cli.js.
  // The saved path must be flattened - dist/src/cli.js no longer exists.
  const rootPkg = await readJSON(Path.join(testDir, "package.json"));
  expect(rootPkg.bin.mytool).toBe("./dist/cli.js");

  const real = await FS.readFile(Path.join(testDir, "dist", "cli.js"), "utf-8");
  expect(real.startsWith("#!")).toBe(true);

  await removeTempDir(testDir);
});

test("flat layout: npm pack ships root modules, no src/ paths", async () => {
  const testDir = await createTempDir("flat-pack");
  await copyFixture("multi-entry", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // multi-entry fixture has private: true; npm pack --dry-run still refuses,
  // so drop it for the pack check (publish protection is tested elsewhere)
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  delete distPkg.private;
  await FS.writeFile(Path.join(distDir, "package.json"), JSON.stringify(distPkg, null, 2));

  const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {cwd: distDir, stdout: "pipe", stderr: "pipe"});
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const packed = JSON.parse(out)[0].files.map((f: any) => f.path);

  // Canonical modules at the tarball root (clean CDN URLs: <pkg>/index.js)
  expect(packed).toContain("index.js");
  expect(packed).toContain("utils.js");
  expect(packed).toContain("package.json");
  // Clean break: nothing ships under src/
  expect(packed.some((p: string) => p.startsWith("src/"))).toBe(false);

  await removeTempDir(testDir);
});
