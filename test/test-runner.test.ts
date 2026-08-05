import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as FSSync from "fs";
import * as Path from "path";
import {bundleTests, collectTests, parseTapOutput, runCompleted, runTests} from "../src/_test-runner.ts";
import {
  installSnapshotMatcher,
  wrapTestApi,
  parseSnapshots,
  formatSnapshots,
  snapshotPathFor,
} from "../src/_snapshot.ts";
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

test("test-setup.test.* is discovered by the ordinary test glob, excluded, and loaded first (#13)", async () => {
  const testDir = await createTempDir("runner-setup");
  const projDir = Path.join(testDir, "proj");
  const outDir = Path.join(testDir, "out");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.mkdir(outDir, {recursive: true});

  // The setup file is a *.test.* match, so it's found by the SAME glob as the
  // test files - then recognized by name, pulled out of the run, imported first.
  const setupPath = Path.join(projDir, "test", "test-setup.test.ts");
  const testPath = Path.join(projDir, "test", "sample.test.ts");
  // Side-effect assignments (not consts) so esbuild can't tree-shake the markers
  await FS.writeFile(setupPath, 'globalThis.__SETUP_MARKER__ = true;\n');
  await FS.writeFile(testPath, 'globalThis.__TEST_MARKER__ = true;\n');

  // Discovery + exclusion: setup found via the plain *.test.ts glob, and NOT
  // counted as a test file
  const {testFiles, setupFile} = await collectTests(projDir, ["**/*.test.ts"]);
  expect(setupFile).not.toBeNull();
  expect(await FS.realpath(setupFile!)).toBe(await FS.realpath(setupPath));
  expect(testFiles.map(f => Path.basename(f))).toEqual(["sample.test.ts"]);

  // Ordering: the generated bundle imports the setup before the test
  const bundle = await FS.readFile(
    await bundleTests(testFiles, "node", outDir, projDir, "", setupFile), "utf-8");
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

test("more than one test-setup.test.* file is an error (#13)", async () => {
  const testDir = await createTempDir("runner-setup-multi");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.mkdir(Path.join(projDir, "src"), {recursive: true});

  // One global setup is the model - two is ambiguous, so it must error rather
  // than silently pick one.
  await FS.writeFile(Path.join(projDir, "test", "test-setup.test.ts"), "// a\n");
  await FS.writeFile(Path.join(projDir, "src", "test-setup.test.ts"), "// b\n");

  let threw = false;
  try {
    await collectTests(projDir, ["**/*.test.ts"]);
  } catch (e: any) {
    threw = true;
    expect(e.message).toContain("one global setup file");
  }
  expect(threw).toBe(true);

  await removeTempDir(testDir);
});

// A node --test TAP transcript with: one pass, one todo (not ok # TODO),
// one skip (ok # SKIP), one real failure, and one real failure whose NAME
// contains an escaped "\# TODO" (must NOT be read as a directive).
const NODE_TAP = `TAP version 13
# Subtest: passes
ok 1 - passes
  ---
  duration_ms: 1
  type: 'test'
  ...
# Subtest: a todo
not ok 2 - a todo # TODO
  ---
  duration_ms: 1
  type: 'test'
  ...
# Subtest: a skip
ok 3 - a skip # SKIP
  ---
  duration_ms: 0
  type: 'test'
  ...
# Subtest: real failure
not ok 4 - real failure
  ---
  duration_ms: 2
  type: 'test'
  ...
# Subtest: handles \\# TODO in name
not ok 5 - handles \\# TODO in name
  ---
  duration_ms: 1
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 1
# fail 2
# cancelled 0
# skipped 1
# todo 1
# duration_ms 6
`;

test("parseTapOutput: todo/skip are not failures; summary lines authoritative (#15)", () => {
  const r = parseTapOutput(NODE_TAP);
  expect(r.passed).toBe(1);
  expect(r.failed).toBe(2);   // the two real failures only, NOT the todo
  expect(r.todo).toBe(1);
  expect(r.skipped).toBe(1);

  // Only the genuine failures are named; todo/skip are excluded
  const names = r.errors.map(e => e.name);
  expect(names).toContain("real failure");
  expect(names.some(n => n.includes("# TODO in name"))).toBe(true); // escaped # is a real failure
  expect(names.some(n => n === "a todo # TODO")).toBe(false);
  expect(names.some(n => n.includes("a skip"))).toBe(false);
});

test("parseTapOutput: directive-aware fallback tally when summary lines absent (#15)", () => {
  // Strip node's "# pass/# fail/..." summary so the per-test tally is exercised
  const noSummary = NODE_TAP.split("\n").filter(l => !/^#\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(l)).join("\n");
  const r = parseTapOutput(noSummary);
  expect(r.passed).toBe(1);
  expect(r.failed).toBe(2);
  expect(r.todo).toBe(1);
  expect(r.skipped).toBe(1);
  expect(r.errors.map(e => e.name)).toContain("real failure");
});

test("runCompleted: killed or summary-less runs are not successes (#16)", () => {
  // Clean, completed run
  expect(runCompleted(true, null)).toBe(true);
  // Killed by a signal (timeout/OOM) - NOT a success even if a summary parsed
  expect(runCompleted(true, "SIGTERM")).toBe(false);
  expect(runCompleted(true, "SIGKILL")).toBe(false);
  // No summary produced (crashed before finishing) - NOT a success
  expect(runCompleted(false, null)).toBe(false);
});

test("parseTapOutput.completed distinguishes a real run from a killed one (#16)", () => {
  expect(parseTapOutput(NODE_TAP).completed).toBe(true);
  // Empty / summary-less output (killed before any result) -> not completed
  expect(parseTapOutput("").completed).toBe(false);
  expect(parseTapOutput("TAP version 13\n# Subtest: x\n").completed).toBe(false);
  // A clean zero-test run still emits "# tests 0" -> completed
  expect(parseTapOutput("TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0\n").completed).toBe(true);
});

test("a killed (timed-out) test run is reported as failure, not a false green (#16)", async () => {
  const testDir = await createTempDir("runner-killed");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  // Top-level await that never resolves: the child hangs at module load and is
  // killed by the spawn timeout, producing no result summary.
  await FS.writeFile(Path.join(projDir, "test", "hang.test.ts"),
    "await new Promise(() => {});\nexport {};\n");

  const ok = await runTests({
    cwd: projDir,
    platforms: ["node"],
    patterns: ["**/test/**/*.ts"],
    timeout: 3000,
  });

  // Before #16 this returned true (0 passed, 0 failed -> false green)
  expect(ok).toBe(false);

  await removeTempDir(testDir);
});

test("each test file runs in its own process — default isolation (#16)", async () => {
  const testDir = await createTempDir("runner-isolation");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});

  // Two files that each set a global and assert the OTHER's global is absent.
  // In a single shared process (the old model) whichever runs second sees the
  // first's global and fails — order-independently. With per-file isolation,
  // each runs in a fresh process and both pass. (Uses node:test directly so the
  // hermetic temp dir needs no @b9g/libuild/test / expect resolution.)
  await FS.writeFile(Path.join(projDir, "test", "a.test.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\n' +
    'test("a", () => { assert.strictEqual(globalThis.__B__, undefined); globalThis.__A__ = true; });\n');
  await FS.writeFile(Path.join(projDir, "test", "b.test.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\n' +
    'test("b", () => { assert.strictEqual(globalThis.__A__, undefined); globalThis.__B__ = true; });\n');

  const ok = await runTests({
    cwd: projDir,
    platforms: ["node"],
    patterns: ["**/test/**/*.ts"],
    timeout: 30000,
  });

  // Passes only if a and b ran in separate processes.
  expect(ok).toBe(true);

  await removeTempDir(testDir);
});

test("one failing file makes the whole run fail; counts aggregate across files (#16)", async () => {
  const testDir = await createTempDir("runner-aggregate");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});

  await FS.writeFile(Path.join(projDir, "test", "pass.test.ts"),
    'import {test} from "node:test";\ntest("p", () => {});\n');
  await FS.writeFile(Path.join(projDir, "test", "fail.test.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\ntest("f", () => { assert.strictEqual(1, 2); });\n');

  const ok = await runTests({
    cwd: projDir,
    platforms: ["node"],
    patterns: ["**/test/**/*.ts"],
    timeout: 30000,
  });

  expect(ok).toBe(false);

  await removeTempDir(testDir);
});

test("test-setup.test.* is found wherever tests live — co-located in src/ (#13)", async () => {
  const testDir = await createTempDir("runner-flat-setup");
  const projDir = Path.join(testDir, "proj");
  const outDir = Path.join(testDir, "out");
  await FS.mkdir(Path.join(projDir, "src"), {recursive: true});
  await FS.mkdir(outDir, {recursive: true});

  // Co-located layout: tests and setup live together in src/, no test/ dir.
  // Because setup is itself a *.test.* match, the same glob finds it here.
  const setupPath = Path.join(projDir, "src", "test-setup.test.ts");
  const testPath = Path.join(projDir, "src", "sample.test.ts");
  await FS.writeFile(setupPath, "globalThis.__SETUP_MARKER__ = true;\n");
  await FS.writeFile(testPath, "globalThis.__TEST_MARKER__ = true;\n");

  const {testFiles, setupFile} = await collectTests(projDir, ["**/*.test.ts"]);
  expect(setupFile).not.toBeNull();
  expect(await FS.realpath(setupFile!)).toBe(await FS.realpath(setupPath));
  expect(testFiles.map(f => Path.basename(f))).toEqual(["sample.test.ts"]);

  const bundle = await FS.readFile(
    await bundleTests(testFiles, "node", outDir, projDir, "", setupFile), "utf-8");
  expect(bundle.indexOf("__SETUP_MARKER__")).toBeLessThan(bundle.indexOf("__TEST_MARKER__"));

  await removeTempDir(testDir);
});

test("setup file is recognized for the .spec convention too, not just .test (#audit)", async () => {
  const testDir = await createTempDir("runner-spec-setup");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "src"), {recursive: true});

  // A .spec-convention project: setup named test-setup.spec.ts must be found
  // by the .spec glob and recognized (previously only .test was recognized).
  await FS.writeFile(Path.join(projDir, "src", "test-setup.spec.ts"), "globalThis.__S__ = 1;\n");
  await FS.writeFile(Path.join(projDir, "src", "thing.spec.ts"), "export {};\n");

  const {testFiles, setupFile} = await collectTests(projDir, ["**/*.spec.ts"]);
  expect(setupFile).not.toBeNull();
  expect(Path.basename(setupFile!)).toBe("test-setup.spec.ts");
  expect(testFiles.map(f => Path.basename(f))).toEqual(["thing.spec.ts"]);

  await removeTempDir(testDir);
});

// ===========================================================================
// Portable snapshots (#14)
// ===========================================================================

// Capture the matcher the installer registers via expect.extend, and load its
// runtime deps (fs, pretty-format) once. This is exactly what @b9g/libuild/test
// does on bun/node.
let snapMatcher: (this: any, received: unknown, hint?: string) => {pass: boolean; message: () => string};
await installSnapshotMatcher({extend: (m: any) => { snapMatcher = m.toMatchSnapshot; }});

// Simulate one runner-independent snapshot assertion: set the injected globals,
// drive the wrapped describe/test so the name is tracked, and call the matcher
// inside the (tracked) body — the same path a real test takes.
function takeSnapshot(opts: {
  file: string; describe?: string; test: string; value: unknown; update?: boolean; hint?: string;
}): {pass: boolean; message: () => string} {
  (globalThis as any).__LIBUILD_SNAPSHOT_FILE__ = opts.file;
  (globalThis as any).__LIBUILD_UPDATE_SNAPSHOTS__ = opts.update === true;
  let result: any;
  const api = wrapTestApi({
    describe: (_n: string, fn: () => void) => fn(),
    test: (_n: string, fn: () => void) => fn(),
    it: (_n: string, fn: () => void) => fn(),
  });
  const body = () => { result = snapMatcher.call({}, opts.value, opts.hint); };
  if (opts.describe) api.describe(opts.describe, () => api.test(opts.test, body));
  else api.test(opts.test, body);
  return result;
}

test("snapshot .snap format round-trips values with backticks, ${, backslashes, newlines (#14)", () => {
  const map = new Map<string, string>([
    ["plain 1", "hello world"],
    ["multiline 1", "\n┌───┐\n│ x │\n└───┘\n"],
    ["tricky 1", "has a ` backtick, a ${expr} and a \\ backslash"],
  ]);
  const text = formatSnapshots(map);

  // Jest-compatible shape and sorted keys
  expect(text).toContain("// Jest Snapshot v1");
  expect(text).toContain("exports[`plain 1`] = `hello world`;");

  const parsed = parseSnapshots(text);
  expect(parsed).toEqual(map); // exact round-trip, no eval
});

test("snapshot: first run writes the .snap next to the source and passes (#14)", async () => {
  const dir = await createTempDir("snap-write");
  const file = Path.join(dir, "render.test.ts");

  const r = takeSnapshot({file, describe: "box", test: "renders", value: "┌─┐\n└─┘"});
  expect(r.pass).toBe(true); // new snapshot is written, not a failure

  const {path} = snapshotPathFor(file);
  // Written to <dir>/__snapshots__/render.test.ts.snap
  expect(path).toBe(Path.join(dir, "__snapshots__", "render.test.ts.snap"));
  const content = await FS.readFile(path, "utf-8");
  // Jest-style key: "<describe > test> <n>"
  expect(content).toContain("exports[`box > renders 1`]");
  expect(content).toContain("┌─┐");

  await removeTempDir(dir);
});

test("snapshot: a matching stored value passes, a differing one fails (#14)", async () => {
  const dir = await createTempDir("snap-compare");
  const file = Path.join(dir, "a.test.ts");
  const {dir: snapDir, path} = snapshotPathFor(file);
  await FS.mkdir(snapDir, {recursive: true});
  // Pre-seed a snapshot on disk (fresh path -> matcher reads from disk).
  await FS.writeFile(path, formatSnapshots(new Map([["cmp > eq 1", "STORED"]])));

  const match = takeSnapshot({file, describe: "cmp", test: "eq", value: "STORED"});
  expect(match.pass).toBe(true);

  // A different source file (fresh path) with a mismatching stored value fails.
  const file2 = Path.join(dir, "b.test.ts");
  const p2 = snapshotPathFor(file2);
  await FS.mkdir(p2.dir, {recursive: true});
  await FS.writeFile(p2.path, formatSnapshots(new Map([["cmp2 > eq 1", "STORED"]])));

  const miss = takeSnapshot({file: file2, describe: "cmp2", test: "eq", value: "CHANGED"});
  expect(miss.pass).toBe(false);
  expect(miss.message()).toContain("does not match");
  expect(miss.message()).toContain("libuild test -u");

  await removeTempDir(dir);
});

test("snapshot: update mode overwrites a differing stored value (#14)", async () => {
  const dir = await createTempDir("snap-update");
  const file = Path.join(dir, "u.test.ts");
  const {dir: snapDir, path} = snapshotPathFor(file);
  await FS.mkdir(snapDir, {recursive: true});
  await FS.writeFile(path, formatSnapshots(new Map([["upd > v 1", "OLD"]])));

  const r = takeSnapshot({file, describe: "upd", test: "v", value: "NEW", update: true});
  expect(r.pass).toBe(true);

  const stored = parseSnapshots(await FS.readFile(path, "utf-8"));
  expect(stored.get("upd > v 1")).toBe("NEW"); // overwritten

  await removeTempDir(dir);
});

test("snapshot: repeated calls in one test get incrementing keys; objects serialize (#14)", async () => {
  const dir = await createTempDir("snap-counter");
  const file = Path.join(dir, "multi.test.ts");

  // Two snapshots in the SAME test body -> "... 1" and "... 2".
  (globalThis as any).__LIBUILD_SNAPSHOT_FILE__ = file;
  (globalThis as any).__LIBUILD_UPDATE_SNAPSHOTS__ = false;
  const api = wrapTestApi({
    describe: (_n: string, fn: () => void) => fn(),
    test: (_n: string, fn: () => void) => fn(),
    it: (_n: string, fn: () => void) => fn(),
  });
  api.test("two snaps", () => {
    expect(snapMatcher.call({}, "first").pass).toBe(true);
    expect(snapMatcher.call({}, {a: 1, b: [2, 3]}).pass).toBe(true); // object via pretty-format
  });

  const stored = parseSnapshots(FSSync.readFileSync(snapshotPathFor(file).path, "utf-8"));
  expect([...stored.keys()].sort()).toEqual(["two snaps 1", "two snaps 2"]);
  expect(stored.get("two snaps 1")).toBe("first");
  expect(stored.get("two snaps 2")).toContain('"a": 1'); // pretty-format object output

  await removeTempDir(dir);
});

test("wrapTestApi preserves sub-methods declared on the prototype (bun shape) (#14)", () => {
  // bun:test puts .todo/.skip/.only/.each on the PROTOTYPE, not as own props, so
  // Object.getOwnPropertyNames(test) is just [length,name]. Model that here: a
  // callable whose sub-methods live one level up the chain. wrapBlock must walk
  // the chain, else every wrapped test.todo() is undefined and aborts the file.
  const calls: string[] = [];
  const proto: any = Object.create(Function.prototype);
  proto.todo = (n: string) => calls.push(`todo:${n}`);
  proto.skip = (n: string) => calls.push(`skip:${n}`);
  proto.only = (_n: string, body: () => void) => { body(); };
  proto.each = () => (n: string) => calls.push(`each:${n}`);
  const makeBlock = () => {
    const block: any = (_n: string, body?: () => void) => { body?.(); };
    Object.setPrototypeOf(block, proto);
    return block;
  };
  // Sanity: the sub-methods are NOT own props, so an own-names-only copy (the
  // 0.2.12 regression) would drop every one of them.
  expect(Object.getOwnPropertyNames(makeBlock())).not.toContain("todo");

  const api = wrapTestApi({ describe: makeBlock(), test: makeBlock(), it: makeBlock() });
  for (const key of ["todo", "skip", "only", "each"] as const) {
    expect(typeof (api.test as any)[key]).toBe("function");
    expect(typeof (api.it as any)[key]).toBe("function");
    expect(typeof (api.describe as any)[key]).toBe("function");
  }
  (api.test as any).todo("pending");
  (api.test as any).only("live", () => calls.push("only-ran"));
  expect(calls).toEqual(["todo:pending", "only-ran"]);
});

test("wrapTestApi survives a sub-method that throws on read (bun describe.failing) (#14)", () => {
  // bun defines some sub-methods as getters that THROW for the block type they
  // don't apply to (`describe.failing` -> "Cannot get .failing on describe").
  // The wrapper must never read sub-methods eagerly: doing so at module import
  // would throw and take down the entire run (0 passed). The Proxy forwards
  // lazily, so construction is safe and the getter throws only if the user
  // actually reads it - exactly like the native block.
  const proto: any = Object.create(Function.prototype);
  proto.skip = (n: string) => `skip:${n}`;
  Object.defineProperty(proto, "failing", {
    configurable: true,
    enumerable: true,
    get() { throw new Error("Cannot get .failing on describe"); },
  });
  const block: any = (_n: string, body?: () => void) => { body?.(); };
  Object.setPrototypeOf(block, proto);

  let api: any;
  expect(() => { api = wrapTestApi({ describe: block, test: block, it: block }); }).not.toThrow();
  expect(typeof api.describe.skip).toBe("function"); // ordinary sub-methods forwarded
  // The throwing getter is not masked - it forwards, and only when READ.
  expect(() => api.describe.failing).toThrow("Cannot get .failing on describe");
});

test("wrapTestApi works against the REAL bun:test object, not just a mock (#14)", async () => {
  // The mock-based tests above pass even when the wrapper is broken against real
  // bun (which is how 0.2.12/0.2.13/the-first-0.2.14 each shipped a bun regression).
  // bun's sub-methods are branded getters on ScopeFunctions.prototype: reading one
  // against the wrong receiver throws "can only be used on instances of
  // ScopeFunctions", and calling the resolved fn against the wrong `this` throws
  // too. Exercise both against the genuine object. node has plain data props and
  // no such brand, so this guard is bun-only.
  if (typeof (globalThis as any).Bun === "undefined") return;
  const bunTest: any = await import("bun:test");
  const api = wrapTestApi({describe: bunTest.describe, test: bunTest.test, it: bunTest.it});

  // Reading a branded getter (the primary bug) would throw right here.
  for (const key of ["todo", "skip", "only", "skipIf", "todoIf", "each"]) {
    expect(typeof (api.test as any)[key]).toBe("function");
  }
  for (const key of ["skip", "only", "each"]) {
    expect(typeof (api.describe as any)[key]).toBe("function");
  }
  // `.each` is branded at CALL time too; building a registrar from an EMPTY table
  // exercises that path without registering any tests.
  expect(typeof (api.test as any).each([])).toBe("function");
  expect(typeof (api.describe as any).each([])).toBe("function");
});

test("browser bundles target es2022 so the dispatcher's top-level await builds (#14)", async () => {
  const dir = await createTempDir("browser-tla");
  const file = Path.join(dir, "tla.test.ts");
  // The @b9g/libuild/test dispatcher selects its backend with top-level await;
  // browser bundles must target es2022+ or esbuild refuses to emit it. Using TLA
  // directly here proves the target: on es2020 this bundleTests call would throw.
  await FS.writeFile(file, "await Promise.resolve();\nexport {};\n");
  await bundleTests([file], "chromium", dir, dir); // must not throw
  await removeTempDir(dir);
});
