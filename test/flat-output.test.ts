import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {createRequire} from "module";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

// =============================================================================
// FLAT OUTPUT LAYOUT (#9)
//
// Modules publish at the tarball root (dist/<entry>.js) instead of dist/src/.
// dist/src/ holds compatibility stubs so previously published src/-relative
// paths (CDN literal URLs, deep imports bypassing the exports map) resolve.
// =============================================================================

test("flat layout: modules at root, stubs under src/", async () => {
  const testDir = await createTempDir("flat-layout");
  await copyFixture("multi-entry", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // Real modules at the dist root
  for (const entry of ["index", "utils", "api", "cli"]) {
    expect(await fileExists(Path.join(distDir, `${entry}.js`))).toBe(true);
    expect(await fileExists(Path.join(distDir, `${entry}.cjs`))).toBe(true);
  }

  // Compatibility stubs at the old src/ locations
  const stubJs = await FS.readFile(Path.join(distDir, "src", "utils.js"), "utf-8");
  expect(stubJs).toContain('export * from "../utils.js"');
  const stubCjs = await FS.readFile(Path.join(distDir, "src", "utils.cjs"), "utf-8");
  expect(stubCjs).toContain('module.exports = require("../utils.cjs")');

  // Stubs are stubs, not copies - real code stays at the root only
  const realJs = await FS.readFile(Path.join(distDir, "utils.js"), "utf-8");
  expect(realJs).toContain("function add");
  expect(stubJs).not.toContain("function add");

  // Package.json points at the root (canonical) paths
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.module).toBe("index.js");
  expect(distPkg.exports["."].import).toBe("./index.js");
  expect(distPkg.exports["./utils"].import).toBe("./utils.js");

  await removeTempDir(testDir);
});

test("flat layout: stubs resolve at runtime (old deep-path consumers)", async () => {
  const testDir = await createTempDir("flat-stub-runtime");
  await copyFixture("multi-entry", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // ESM stub forwards named exports (simulates a CDN literal /src/ URL or a
  // bundler resolving the literal file path)
  const esmStub = await import(Path.join(distDir, "src", "utils.js"));
  expect(esmStub.add(2, 3)).toBe(5);

  // CJS stub forwards module.exports
  const require = createRequire(import.meta.url);
  const cjsStub = require(Path.join(distDir, "src", "utils.cjs"));
  expect(cjsStub.add(4, 5)).toBe(9);

  await removeTempDir(testDir);
});

test("flat layout: stubs forward default exports (metafile-driven)", async () => {
  const testDir = await createTempDir("flat-stub-default");
  await copyFixture("flat-augmentation", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // index has a default export - the stub must re-export it explicitly
  // (export * does not forward default)
  const stub = await FS.readFile(Path.join(distDir, "src", "index.js"), "utf-8");
  expect(stub).toContain('export * from "../index.js"');
  expect(stub).toContain('export {default} from "../index.js"');

  const viaStub = await import(Path.join(distDir, "src", "index.js"));
  expect(viaStub.default(3).rows).toBe(3);
  expect(viaStub.table(7).rows).toBe(7);

  // A module without a default export must NOT get the default re-export
  // (it would be a link error)
  const utilsDir = await createTempDir("flat-stub-no-default");
  await copyFixture("multi-entry", utilsDir);
  await build(utilsDir);
  const noDefaultStub = await FS.readFile(Path.join(utilsDir, "dist", "src", "utils.js"), "utf-8");
  expect(noDefaultStub).not.toContain("export {default}");

  await removeTempDir(testDir);
  await removeTempDir(utilsDir);
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

  // The d.ts stub re-exports the real declarations (augmentation applies
  // transitively for consumers who resolve the old src/ path)
  const dtsStub = await FS.readFile(Path.join(distDir, "src", "index.d.ts"), "utf-8");
  expect(dtsStub).toContain('export * from "../index.js"');

  await removeTempDir(testDir);
});

test("flat layout: UMD builds to root, compat copy under src/, siblings not wrapped", async () => {
  const testDir = await createTempDir("flat-umd");
  await copyFixture("with-umd", testDir);

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // UMD at the root, wrapped
  const umd = await FS.readFile(Path.join(distDir, "umd.js"), "utf-8");
  expect(umd).toContain("typeof define === 'function' && define.amd");

  // Compat copy is a real UMD file (script tags can't follow ESM stubs)
  const umdCompat = await FS.readFile(Path.join(distDir, "src", "umd.js"), "utf-8");
  expect(umdCompat).toContain("typeof define === 'function' && define.amd");

  // Regression: the UMD pass must not wrap sibling entry files
  // (on main, every .js in the UMD outdir was wrapped and corrupted)
  const index = await FS.readFile(Path.join(distDir, "index.js"), "utf-8");
  expect(index).not.toContain("define.amd");
  expect(index).toContain("export");

  await removeTempDir(testDir);
});

test("flat layout: --save root bin points at the real executable, not the stub", async () => {
  const testDir = await createTempDir("flat-save-bin");
  await copyFixture("multi-entry", testDir);

  await build(testDir, true); // --save

  // Author bin was "src/cli.js"; the flat dist location is dist/cli.js.
  // dist/src/cli.js also EXISTS (compat stub) - the root bin must not point
  // there, since the stub has no shebang and isn't executable.
  const rootPkg = await readJSON(Path.join(testDir, "package.json"));
  expect(rootPkg.bin.mytool).toBe("./dist/cli.js");

  const real = await FS.readFile(Path.join(testDir, "dist", "cli.js"), "utf-8");
  expect(real.startsWith("#!")).toBe(true);

  await removeTempDir(testDir);
});

test("flat layout: npm pack ships root modules and src/ stubs", async () => {
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
  // Compatibility stubs shipped too (old CDN URLs: <pkg>/src/index.js)
  expect(packed).toContain("src/index.js");
  expect(packed).toContain("src/utils.cjs");

  await removeTempDir(testDir);
});
