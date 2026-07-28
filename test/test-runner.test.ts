import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {bundleTests, collectTests} from "../src/test-runner.ts";
import {createTempDir, removeTempDir} from "./test-utils.ts";

// A bundle-hostile CJS package that resolves a sibling file at load time,
// standing in for jsdom (which require.resolve()s xhr-sync-worker.js). When
// inlined the sibling path no longer resolves; when external it loads fine.
async function writeFakeDep(projDir: string) {
  const depDir = Path.join(projDir, "node_modules", "fake-dep");
  await FS.mkdir(depDir, {recursive: true});
  await FS.writeFile(Path.join(depDir, "package.json"),
    JSON.stringify({name: "fake-dep", version: "1.0.0", main: "index.js"}));
  await FS.writeFile(Path.join(depDir, "index.js"),
    'const s = require("./sibling.js");\nmodule.exports = {value: s};\n');
  await FS.writeFile(Path.join(depDir, "sibling.js"),
    'module.exports = "SIBLING_LOADED_MARKER";\n');
}

test("node bundle externalizes node_modules deps; browser inlines them (#12)", async () => {
  const testDir = await createTempDir("runner-external");
  const projDir = Path.join(testDir, "proj");
  const outDir = Path.join(testDir, "out");
  await FS.mkdir(projDir, {recursive: true});
  await FS.mkdir(outDir, {recursive: true});
  await writeFakeDep(projDir);

  // A test file (next to node_modules) importing the bundle-hostile dep
  const testFile = Path.join(projDir, "sample.test.ts");
  await FS.writeFile(testFile,
    'import * as dep from "fake-dep";\nif (!dep.value) throw new Error("no dep");\n');

  const nodeBundle = await FS.readFile(
    await bundleTests([testFile], "node", outDir, projDir), "utf-8");
  const browserBundle = await FS.readFile(
    await bundleTests([testFile], "chromium", outDir, projDir), "utf-8");

  // node: dep stays external - its source is NOT inlined, and it survives
  // as a bare runtime import the runtime resolves from node_modules
  expect(nodeBundle).not.toContain("SIBLING_LOADED_MARKER");
  expect(/["']fake-dep["']/.test(nodeBundle)).toBe(true);

  // browser: no node_modules at runtime, so the dep IS inlined
  expect(browserBundle).toContain("SIBLING_LOADED_MARKER");

  await removeTempDir(testDir);
});

test("setup file (test/test-setup.*) is discovered, loaded first, and excluded from tests (#13)", async () => {
  const testDir = await createTempDir("runner-setup");
  const projDir = Path.join(testDir, "proj");
  const outDir = Path.join(testDir, "out");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.mkdir(outDir, {recursive: true});

  // Setup file and a test file, both under test/. The **/test/** glob catches
  // both; the setup file must be pulled out of the test set and imported first.
  const setupPath = Path.join(projDir, "test", "test-setup.ts");
  const testPath = Path.join(projDir, "test", "sample.test.ts");
  // Side-effect assignments (not consts) so esbuild can't tree-shake the markers
  await FS.writeFile(setupPath, 'globalThis.__SETUP_MARKER__ = true;\n');
  await FS.writeFile(testPath, 'globalThis.__TEST_MARKER__ = true;\n');

  // Discovery + exclusion: setup found, and NOT counted as a test file
  const {testFiles, setupFile} = await collectTests(projDir, [
    "**/*.test.ts",
    "**/test/**/*.ts",
  ]);
  expect(setupFile).not.toBeNull();
  expect(await FS.realpath(setupFile!)).toBe(await FS.realpath(setupPath));
  expect(testFiles.map(f => Path.basename(f))).toContain("sample.test.ts");
  expect(testFiles.map(f => Path.basename(f))).not.toContain("test-setup.ts");

  // Ordering: the generated bundle imports the setup before the test
  const bundle = await FS.readFile(
    await bundleTests(testFiles, "node", outDir, projDir), "utf-8");
  expect(bundle).toContain("__SETUP_MARKER__");
  expect(bundle).toContain("__TEST_MARKER__");
  expect(bundle.indexOf("__SETUP_MARKER__")).toBeLessThan(bundle.indexOf("__TEST_MARKER__"));

  await removeTempDir(testDir);
});

test("no setup file present -> no setup import, no error (#13)", async () => {
  const testDir = await createTempDir("runner-no-setup");
  const projDir = Path.join(testDir, "proj");
  const outDir = Path.join(testDir, "out");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.mkdir(outDir, {recursive: true});

  const testPath = Path.join(projDir, "test", "sample.test.ts");
  await FS.writeFile(testPath, 'const __TEST_MARKER__ = 1;\nexport {};\n');

  const {testFiles, setupFile} = await collectTests(projDir, ["**/test/**/*.ts"]);
  expect(setupFile).toBeNull();

  const bundle = await FS.readFile(
    await bundleTests(testFiles, "node", outDir, projDir), "utf-8");
  expect(bundle).not.toContain("Setup file - runs before all tests");

  await removeTempDir(testDir);
});

test("setup file extension precedence: .ts wins over .js (#13)", async () => {
  const testDir = await createTempDir("runner-setup-ext");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});

  await FS.writeFile(Path.join(projDir, "test", "test-setup.js"), "// js\n");
  await FS.writeFile(Path.join(projDir, "test", "test-setup.ts"), "// ts\n");

  const {setupFile} = await collectTests(projDir, ["**/test/**/*.ts"]);
  expect(Path.basename(setupFile!)).toBe("test-setup.ts");

  await removeTempDir(testDir);
});
