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
  const errOut = await new Response(proc.stderr).text();
  await proc.exited;
  // Parse defensively and fail LOUD: an environment problem (auth-poisoned
  // .npmrc, npm output-format change) must show npm's actual output, not a
  // bare "undefined is not an object" (first seen on the first-ever CI run).
  let packed: string[];
  try {
    // npm pack --json emits an ARRAY of results up through 11.19 and an
    // OBJECT keyed by package name on newer npm (first seen on CI's
    // npm@latest) - accept both shapes.
    const parsed = JSON.parse(out);
    const entry = Array.isArray(parsed) ? parsed[0] : (Object.values(parsed)[0] as any);
    packed = entry.files.map((f: any) => f.path);
  } catch (error: any) {
    throw new Error(`npm pack --json output unparseable (exit ${proc.exitCode}): ${error?.message}\nstdout:\n${out}\nstderr:\n${errOut}`);
  }

  // Canonical modules at the tarball root (clean CDN URLs: <pkg>/index.js)
  expect(packed).toContain("index.js");
  expect(packed).toContain("utils.js");
  expect(packed).toContain("package.json");
  // Clean break: nothing ships under src/
  expect(packed.some((p: string) => p.startsWith("src/"))).toBe(false);

  await removeTempDir(testDir);
});

test(".tsx entry points are discovered and built (#6)", async () => {
  const testDir = await createTempDir("tsx-entry");

  await FS.mkdir(Path.join(testDir, "src"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "tsx-lib",
    version: "1.0.0",
    type: "module",
    module: "./dist/index.js",
    private: true
  }, null, 2));
  // hermetic JSX via pragma - no external jsx runtime needed
  await FS.writeFile(Path.join(testDir, "src", "h.ts"),
    "export function h(tag: any, props: any, ...children: any[]) { return {tag, props, children}; }");
  await FS.writeFile(Path.join(testDir, "src", "widget.tsx"),
    '/** @jsx h */\nimport {h} from "./h.js";\nexport function widget(name: string) { return <div title={name}>hi</div>; }');
  await FS.writeFile(Path.join(testDir, "src", "index.ts"),
    'export {widget} from "./widget.js";');

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // .tsx entry built to root as .js
  expect(await fileExists(Path.join(distDir, "widget.js"))).toBe(true);
  const js = await FS.readFile(Path.join(distDir, "widget.js"), "utf-8");
  expect(js).not.toContain("<div"); // JSX compiled away

  // runtime works
  const mod = await import(Path.join(distDir, "widget.js"));
  const node = mod.widget("x");
  expect(node.tag).toBe("div");
  expect(node.props.title).toBe("x");

  // exports map includes the tsx entry
  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.exports["./widget"].import).toBe("./widget.js");

  // declarations (if tsc available)
  if (await fileExists(Path.join(distDir, "index.d.ts"))) {
    expect(await fileExists(Path.join(distDir, "widget.d.ts"))).toBe(true);
  }

  await removeTempDir(testDir);
});

test("UMD bundle works via require() and as a browser global (0.2.2)", async () => {
  const testDir = await createTempDir("umd-modes");
  await copyFixture("with-umd", testDir);

  await build(testDir);

  const umdCode = await FS.readFile(Path.join(testDir, "dist", "umd.js"), "utf-8");

  // (a) CJS: a real require() must yield the exports. The factory body is
  // esbuild cjs output whose internal `module.exports = ...` used to write
  // to the REAL module and then return undefined, so the wrapper clobbered
  // exports with `module.exports = factory()` -> undefined
  const cjsPath = Path.join(testDir, "umd-require-check.cjs");
  await FS.writeFile(cjsPath, umdCode);
  const {createRequire} = await import("module");
  const cjsExports = createRequire(import.meta.url)(cjsPath);
  expect(typeof cjsExports.createWidget).toBe("function");
  expect(cjsExports.createWidget("w").name).toBe("w");

  // (b) Browser <script>: no `module` in scope at all. The bare
  // `module.exports =` in the factory used to throw ReferenceError before
  // the global was ever assigned
  const fakeRoot: any = {};
  new Function("self", "module", "define", umdCode)(fakeRoot, undefined, undefined);
  expect(typeof fakeRoot.Umdlib).toBe("object");
  expect(typeof fakeRoot.Umdlib.createWidget).toBe("function");
  expect(fakeRoot.Umdlib.createWidget("w").name).toBe("w");

  await removeTempDir(testDir);
});

test("relocated subdirectory declarations ship in the tarball (#11)", async () => {
  const testDir = await createTempDir("nested-dts-pack");

  await FS.mkdir(Path.join(testDir, "src", "internal"), {recursive: true});
  await FS.writeFile(Path.join(testDir, "src", "index.ts"),
    'export {helper} from "./internal/helper.js";');
  await FS.writeFile(Path.join(testDir, "src", "internal", "helper.ts"),
    "export function helper(): number { return 1; }");
  await FS.writeFile(Path.join(testDir, "extra.txt"), "author extra\n");
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify({
    name: "nested-dts-lib",
    version: "1.0.0",
    type: "module",
    module: "./dist/index.js",
    // An author files field survives into dist, which switches the dist
    // package.json onto the whitelist path - the case where nested .d.ts
    // got excluded from the tarball
    files: ["extra.txt"]
  }, null, 2));

  await build(testDir);

  const distDir = Path.join(testDir, "dist");

  // TypeScript may be unavailable in some environments - skip like other tests do
  if (!await fileExists(Path.join(distDir, "index.d.ts"))) {
    console.log("⚠ TypeScript declarations not available (tsc not found)");
    await removeTempDir(testDir);
    return;
  }

  const distPkg = await readJSON(Path.join(distDir, "package.json"));
  expect(distPkg.files).toContain("internal/");

  const proc = Bun.spawn(["npm", "pack", "--dry-run", "--json"], {cwd: distDir, stdout: "pipe", stderr: "pipe"});
  const out = await new Response(proc.stdout).text();
  const errOut = await new Response(proc.stderr).text();
  await proc.exited;
  // Parse defensively and fail LOUD: an environment problem (auth-poisoned
  // .npmrc, npm output-format change) must show npm's actual output, not a
  // bare "undefined is not an object" (first seen on the first-ever CI run).
  let packed: string[];
  try {
    // npm pack --json emits an ARRAY of results up through 11.19 and an
    // OBJECT keyed by package name on newer npm (first seen on CI's
    // npm@latest) - accept both shapes.
    const parsed = JSON.parse(out);
    const entry = Array.isArray(parsed) ? parsed[0] : (Object.values(parsed)[0] as any);
    packed = entry.files.map((f: any) => f.path);
  } catch (error: any) {
    throw new Error(`npm pack --json output unparseable (exit ${proc.exitCode}): ${error?.message}\nstdout:\n${out}\nstderr:\n${errOut}`);
  }

  // The relocated declaration referenced by index.d.ts actually ships
  expect(packed).toContain("internal/helper.d.ts");
  expect(packed).toContain("index.d.ts");
  expect(packed).toContain("extra.txt");

  await removeTempDir(testDir);
});
