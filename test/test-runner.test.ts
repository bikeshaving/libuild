import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as FSSync from "fs";
import * as Path from "path";
import {bundleTests, collectTests, packageTypeRefusal, parseBunOutput, parseRegistered, parseTapOutput, resolveTestTargets, shardFailure, stripRegistered, runTests} from "../src/_test-runner.ts";
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

const OK_RUN = {completed: true, code: 0, signal: null, timedOut: false, failed: 0, timeout: 60000, finished: 3};

test("shardFailure: killed or summary-less runs are not successes (#16)", () => {
  // Clean, completed run
  expect(shardFailure(OK_RUN)).toBeNull();
  // Ordinary failing run: reported by the runner, not by us
  expect(shardFailure({...OK_RUN, code: 1, failed: 2})).toBeNull();
  // Killed by a signal (OOM) - NOT a success even if a summary parsed
  expect(shardFailure({...OK_RUN, signal: "SIGKILL"})).toMatch(/SIGKILL/);
  // No summary produced (crashed before finishing) - NOT a success
  expect(shardFailure({...OK_RUN, completed: false, code: 7})).toMatch(/without producing a test summary/);
});

test("shardFailure: a timeout is a failure that names the count it got through (#18)", () => {
  // The exact shape of a timed-out `node --test`: it traps SIGTERM, prints TAP
  // for the tests it finished, and exits (1, null) - byte-identical by exit
  // status to an ordinary failing run, which is how it used to pass as green.
  const reason = shardFailure({
    completed: true, code: 1, signal: null, timedOut: true,
    failed: 0, timeout: 60000, finished: 12,
  });
  expect(reason).toBeTruthy();
  expect(reason).toMatch(/timed out after 60000ms/);
  expect(reason).toMatch(/12 test\(s\) finished/);
});

test("timeout message carries the registered total when the child reported one", () => {
  const withTotal = shardFailure({
    completed: true, code: 1, signal: null, timedOut: true,
    failed: 0, timeout: 60000, finished: 12, registered: 47,
  });
  expect(withTotal).toMatch(/12 of 47 test\(s\) finished/);

  // Files that don't import @b9g/libuild/test never report a total; the
  // message must still read correctly without a denominator.
  const withoutTotal = shardFailure({
    completed: true, code: 1, signal: null, timedOut: true,
    failed: 0, timeout: 60000, finished: 12, registered: null,
  });
  expect(withoutTotal).toMatch(/12 test\(s\) finished/);
  expect(withoutTotal).not.toMatch(/ of /);
});

test("parseRegistered takes the last total; stripRegistered hides the markers", () => {
  // node's TAP reporter re-emits child stdout as a "# " comment
  expect(parseRegistered("# __LIBUILD_REGISTERED__ 47\nok 1 - x\n")).toBe(47);
  // Several emits (top-level await, tests registering tests) -> last wins
  expect(parseRegistered("__LIBUILD_REGISTERED__ 3\n__LIBUILD_REGISTERED__ 9\n")).toBe(9);
  // A file that never reports one
  expect(parseRegistered("ok 1 - x\n")).toBeNull();

  // The marker is plumbing, never user-facing output
  const dump = "ok 1 - x\n# __LIBUILD_REGISTERED__ 47\nnot ok 2 - y\n";
  expect(stripRegistered(dump)).toBe("ok 1 - x\nnot ok 2 - y\n");
  expect(stripRegistered(dump)).not.toMatch(/__LIBUILD_REGISTERED__/);
});

test("a test's own output cannot hijack the count or vanish from the dump", () => {
  // A console.log mentioning the marker mid-sentence, or a bun code frame
  // quoting the bundle's own marker constant, must neither be PARSED as a
  // count nor be STRIPPED from the failure dump - an unanchored scan let a
  // 4-test file report "0 of 99" while eating the very line explaining the
  // failure.
  const chatter = 'my test says __LIBUILD_REGISTERED__ 99 (own output)\n' +
    'var REGISTERED_MARKER = "__LIBUILD_REGISTERED__";\n' +
    '__LIBUILD_REGISTERED__ 4\n';
  expect(parseRegistered(chatter)).toBe(4);
  const stripped = stripRegistered(chatter);
  expect(stripped).toContain("own output");
  expect(stripped).toContain("var REGISTERED_MARKER");
  expect(stripped).not.toMatch(/^__LIBUILD_REGISTERED__ 4$/m);
});

test("shardFailure: finishing cleanly at the buzzer is not a timeout failure", () => {
  // The kill timer fires unconditionally; if the child had already produced a
  // full summary and exited 0 (node flushes TAP on SIGTERM), nothing was
  // lost - reporting "N of N finished, the rest never ran" would be nonsense.
  expect(shardFailure({
    completed: true, code: 0, signal: null, timedOut: true,
    failed: 0, timeout: 5000, finished: 12, registered: 12,
  })).toBeNull();
  // But a timed-out child that EXITED NONZERO still fails.
  expect(shardFailure({
    completed: true, code: 1, signal: null, timedOut: true,
    failed: 0, timeout: 5000, finished: 12, registered: 47,
  })).toMatch(/timed out/);
});

test("an inconsistent denominator (finished > registered) is suppressed", () => {
  // Registration paths we don't wrap (runtime-specific sub-methods) can
  // undercount; "5 of 2" is worse than "5".
  const reason = shardFailure({
    completed: true, code: 1, signal: null, timedOut: true,
    failed: 0, timeout: 5000, finished: 5, registered: 2,
  });
  expect(reason).toMatch(/5 test\(s\) finished/);
  expect(reason).not.toMatch(/ of /);
});

test("parseBunOutput reports skip/todo so the x-of-y numerator matches", () => {
  const out = "bun test v1.3.14\n\n 3 pass\n 2 skip\n 1 todo\n 0 fail\nRan 6 tests\n";
  const r = parseBunOutput(out);
  expect(r.passed).toBe(3);
  expect(r.skipped).toBe(2);
  expect(r.todo).toBe(1);
  expect(r.failed).toBe(0);
  expect(r.completed).toBe(true);
});

test("shardFailure: completed-but-nonzero with no failing test is not green (#18)", () => {
  // Tests went missing somewhere we can't see (unhandled rejection, runner
  // error). Reporting "0 failed" here is the false-green this guards against.
  expect(shardFailure({...OK_RUN, code: 1, failed: 0})).toMatch(/reported no failing tests/);
});

// The two suite-failure shapes node emits (captured from node 25). A suite
// that THREW during registration carries failureType 'testCodeFailure'; a
// suite that is not ok merely because a child failed carries 'subtestsFailed'.
// Node counts both under `# suites`, not `# fail`, and exits 0 for the former.
const SUITE_THROW_TAP = `TAP version 13
# Subtest: outer
    # Subtest: passes
    ok 1 - passes
      ---
      duration_ms: 1
      type: 'test'
      ...
    # Subtest: callback throws
    not ok 2 - callback throws
      ---
      duration_ms: 0.5
      type: 'suite'
      failureType: 'testCodeFailure'
      error: 'BOOM: describe callback threw'
      code: 'ERR_TEST_FAILURE'
      ...
    # Subtest: after the throw
    ok 3 - after the throw
      ---
      duration_ms: 1
      type: 'test'
      ...
    1..3
not ok 1 - outer
  ---
  duration_ms: 5
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 2
# suites 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6
`;

test("a throw during suite registration is a named failure, not a green run (#23)", () => {
  const r = parseTapOutput(SUITE_THROW_TAP);
  // node reports "# fail 0" and exits 0 here - the registration throw only
  // exists as a `not ok` suite entry. It must surface as a failure with the
  // actual error text, and the parent's 'subtestsFailed' must NOT also count
  // (that would double-count every ordinary failure through its ancestors).
  expect(r.passed).toBe(2);
  expect(r.failed).toBe(1);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].name).toContain("callback throws");
  expect(r.errors[0].error).toContain("BOOM: describe callback threw");
});

test("ordinary failures are not double-counted through their parent suites (#23)", () => {
  const tap = `TAP version 13
# Subtest: parent
    # Subtest: fails normally
    not ok 1 - fails normally
      ---
      duration_ms: 1
      type: 'test'
      failureType: 'testCodeFailure'
      error: 'regular failure'
      ...
    1..1
not ok 1 - parent
  ---
  duration_ms: 2
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  ...
1..1
# tests 1
# suites 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3
`;
  const r = parseTapOutput(tap);
  expect(r.failed).toBe(1); // the test itself; parent suite adds nothing
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].name).toBe("fails normally");
  // Failing tests now carry their error text instead of a generic label.
  expect(r.errors[0].error).toContain("regular failure");
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

test("a file that exceeds the timeout mid-run fails instead of vanishing (#18)", async () => {
  const testDir = await createTempDir("runner-timeout");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  // The #18 shape, distinct from #16's hang-at-load: the file gets FAR enough to
  // report a passing test, then blows the budget. node traps our SIGTERM and
  // exits (1, null) with valid partial TAP, so the old signal-only check read it
  // as "1 passed, 0 failed" and the never-run tests just disappeared.
  await FS.writeFile(Path.join(projDir, "test", "slow.test.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\n' +
    'test("quick", () => { assert.ok(true); });\n' +
    'test("slow", async () => { await new Promise(r => setTimeout(r, 60000)); });\n' +
    'test("never runs", () => { assert.ok(true); });\n');

  const ok = await runTests({
    cwd: projDir,
    platforms: ["node"],
    patterns: ["**/test/**/*.ts"],
    timeout: 4000,
  });

  expect(ok).toBe(false);

  await removeTempDir(testDir);
});

test("runTests runs only the explicitly named file (#19)", async () => {
  const testDir = await createTempDir("runner-single-file");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});

  await FS.writeFile(Path.join(projDir, "test", "good.test.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\n' +
    'test("good", () => { assert.ok(true); });\n');
  // A failing neighbor: if selection leaked back into a full discovery, the
  // single-file run would go red.
  await FS.writeFile(Path.join(projDir, "test", "bad.test.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\n' +
    'test("bad", () => { assert.fail("should not have run"); });\n');

  const good = Path.join(projDir, "test", "good.test.ts");
  expect(await runTests({cwd: projDir, files: [good], platforms: ["node"], timeout: 30000})).toBe(true);

  // ...and the selection is real, not just "everything passes"
  const bad = Path.join(projDir, "test", "bad.test.ts");
  expect(await runTests({cwd: projDir, files: [bad], platforms: ["node"], timeout: 30000})).toBe(false);

  await removeTempDir(testDir);
});

test("a selection that matches nothing fails; empty discovery still passes (#19)", async () => {
  const testDir = await createTempDir("runner-empty-selection");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(projDir, {recursive: true});

  // Plain discovery over a project with no tests: a no-op success.
  expect(await runTests({cwd: projDir, platforms: ["node"], timeout: 30000})).toBe(true);
  // A typo'd --filter must NOT read as green.
  expect(await runTests({cwd: projDir, patterns: ["**/nope-*.test.ts"], platforms: ["node"], timeout: 30000})).toBe(false);

  await removeTempDir(testDir);
});

test("resolveTestTargets: directory, files, globs, and bad paths (#19)", async () => {
  const testDir = await createTempDir("resolve-targets");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  const file = Path.join(projDir, "test", "a.test.ts");
  await FS.writeFile(file, "export {};\n");

  // No targets: discover under the base directory (original behavior)
  expect(await resolveTestTargets(projDir, [])).toEqual({cwd: projDir, files: [], patterns: []});

  // A lone directory IS the root
  const dir = await resolveTestTargets(testDir, ["proj"]);
  expect(dir.cwd).toBe(projDir);
  expect(dir.files).toEqual([]);

  // A file: run exactly it, rooted at the CURRENT dir so setup discovery and
  // printed paths match a full run
  const one = await resolveTestTargets(projDir, ["test/a.test.ts"]);
  expect(one.cwd).toBe(projDir);
  expect(one.files).toEqual([file]);

  // An unexpanded/quoted glob is kept as a pattern
  expect((await resolveTestTargets(projDir, ["test/**/*.test.ts"])).patterns).toEqual(["test/**/*.test.ts"]);

  // A typo'd path is an error, not a silent empty run
  const rejection = async (targets: string[]): Promise<string> => {
    try {
      await resolveTestTargets(projDir, targets);
      return "";
    } catch (error: any) {
      return error?.message ?? String(error);
    }
  };
  expect(await rejection(["test/nope.test.ts"])).toMatch(/No such test file/);
  // Mixing a directory with other targets is ambiguous
  expect(await rejection(["test", "test/a.test.ts"])).toMatch(/Cannot mix a directory/);

  await removeTempDir(testDir);
});

test("browser bundle parses and contains no live node/bun imports", async () => {
  const testDir = await createTempDir("browser-bundle");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  // Import the real dispatcher so the bundle contains the whole graph the bug
  // lived in: `@b9g/libuild/test` selecting its backend with top-level await.
  await FS.writeFile(Path.join(projDir, "package.json"), JSON.stringify({name: "p", version: "1.0.0"}));
  await FS.mkdir(Path.join(projDir, "node_modules", "@b9g"), {recursive: true});
  await FS.symlink(Path.resolve(import.meta.dir, "../dist"), Path.join(projDir, "node_modules", "@b9g", "libuild"));
  await FS.writeFile(Path.join(projDir, "test", "a.test.ts"),
    'import {test, expect} from "@b9g/libuild/test";\ntest("a", () => { expect(1).toBe(1); });\n');

  const bundle = await bundleTests([Path.join(projDir, "test", "a.test.ts")], "chromium", projDir, projDir);

  // The externals used to survive as live dynamic imports, forcing lazy async
  // wrappers that (on some esbuild versions) put `await init_...()` inside a
  // non-async wrapper - the whole bundle was then a syntax error and every
  // browser run died before a single test executed. Stubbing resolves them
  // inside the bundle, so: (a) it parses, (b) no live imports remain.
  const content = await FS.readFile(bundle, "utf-8");
  // The entry's ready flag is the runner's start signal (ESM guarantees it is
  // set only after every test file - including TLA continuations - has fully
  // evaluated), and the runner must wait on it rather than bet on scheduler
  // ordering.
  expect(content).toMatch(/__LIBUILD_TEST_READY__ = true/);
  expect(content).toMatch(/__LIBUILD_TEST_READY__/);
  // `--input-type=module` only applies to stdin, so pipe the bundle in.
  const {spawn} = await import("child_process");
  const syntax = await new Promise<number>((resolve) => {
    const child = spawn("node", ["--input-type=module", "--check"], {stdio: ["pipe", "ignore", "ignore"]});
    child.stdin.end(content);
    child.on("close", (code) => resolve(code ?? 1));
  });
  expect(syntax).toBe(0);

  expect(content).not.toMatch(/(import\(|from )"(bun:test|node:test|expect|node:fs|pretty-format)"/);
  // The runner must start in a macrotask: a microtask fires before the
  // dispatcher's TLA continuations run test-file bodies -> zero tests register.
  expect(content).toMatch(/setTimeout\(async/);
  expect(content).not.toMatch(/queueMicrotask\(async/);
  // Uncaught errors are captured IN the page with the phase known
  // synchronously: pre-start errors mean lost registrations (fatal), run-time
  // unhandled rejections are warnings - and behavior no longer depends on
  // which browser routes rejections to Playwright's pageerror.
  expect(content).toMatch(/addEventListener\("error"/);
  expect(content).toMatch(/addEventListener\("unhandledrejection"/);
  expect(content).toMatch(/loadErrors/);
  expect(content).toMatch(/runtimeErrors/);

  await removeTempDir(testDir);
});

test("the bundle dir declares type:module so .js bundles load as ESM anywhere", async () => {
  const testDir = await createTempDir("esm-bundle-dir");
  const projDir = Path.join(testDir, "proj");
  const outDir = Path.join(testDir, "out");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.mkdir(outDir, {recursive: true});
  await FS.writeFile(Path.join(projDir, "test", "a.test.ts"),
    'import {test} from "node:test";\ntest("a", () => {});\n');

  // libuild is ESM-only, so the statement lives in ONE place: the bundle
  // directory's own package.json (not per-file .mjs extensions). node resolves
  // the nearest manifest, so bundles load as ESM even when the consumer
  // package has no `type` of its own.
  const bundle = await bundleTests([Path.join(projDir, "test", "a.test.ts")], "node", outDir, projDir);
  expect(bundle.endsWith(".js")).toBe(true);
  expect(JSON.parse(await FS.readFile(Path.join(outDir, "package.json"), "utf-8")).type).toBe("module");

  // A pre-existing manifest at outDir is never clobbered ("wx") - callers
  // pointing outDir at a real project directory keep their package.json.
  await FS.writeFile(Path.join(projDir, "package.json"),
    JSON.stringify({name: "keep-me", version: "1.0.0"}));
  await bundleTests([Path.join(projDir, "test", "a.test.ts")], "node", projDir, projDir);
  expect(JSON.parse(await FS.readFile(Path.join(projDir, "package.json"), "utf-8")).name).toBe("keep-me");

  await removeTempDir(testDir);
});

test("a root that IS a test directory discovers files without the .test infix", async () => {
  const testDir = await createTempDir("testdir-root");
  const projDir = Path.join(testDir, "proj");
  const suiteDir = Path.join(projDir, "test");
  await FS.mkdir(suiteDir, {recursive: true});
  // No `.test.` infix - matched only by the under-a-test-dir rule, which
  // evaluated FROM INSIDE test/ used to demand test/test/ and find nothing.
  // The assertion FAILS on purpose: runTests returning false proves the file
  // was discovered and executed (a discovery miss reports "no files" -> true).
  await FS.writeFile(Path.join(suiteDir, "plain.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\n' +
    'test("ran", () => { assert.fail("discovered and executed"); });\n');

  expect(await runTests({cwd: suiteDir, platforms: ["node"], timeout: 30000})).toBe(false);

  await removeTempDir(testDir);
});

test("browser stubs are scoped: a consumer's own pretty-format import bundles for real", async () => {
  const testDir = await createTempDir("stub-scope");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.writeFile(Path.join(projDir, "package.json"), JSON.stringify({name: "p", version: "1.0.0"}));
  await FS.mkdir(Path.join(projDir, "node_modules", "@b9g"), {recursive: true});
  await FS.symlink(Path.resolve(import.meta.dir, "../dist"), Path.join(projDir, "node_modules", "@b9g", "libuild"));
  await FS.symlink(Path.resolve(import.meta.dir, "../node_modules/pretty-format"), Path.join(projDir, "node_modules", "pretty-format"));

  // The consumer imports pretty-format for THEMSELVES; only libuild's own
  // internal import may be stubbed.
  await FS.writeFile(Path.join(projDir, "test", "a.test.ts"),
    'import {test, expect} from "@b9g/libuild/test";\n' +
    'import {format} from "pretty-format";\n' +
    'test("formats", () => { expect(format({a: 1})).toContain("a"); });\n');

  const bundle = await bundleTests([Path.join(projDir, "test", "a.test.ts")], "chromium", projDir, projDir);
  const content = await FS.readFile(bundle, "utf-8");

  // Real pretty-format code made it into the bundle (consumer's import)...
  expect(content).toMatch(/printListItems|printObjectProperties/);
  // ...while node builtins stay stubbed for everyone (libuild's fs import).
  expect(content).toContain('is not available in the browser test bundle');

  await removeTempDir(testDir);
});

test('libuild test refuses "type": "commonjs" packages on every platform (#21)', async () => {
  const testDir = await createTempDir("cjs-refusal");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  // libuild is ESM-only: an explicit CommonJS declaration is refused loudly
  // with the fix, rather than half-supported (it happened to work on node/bun
  // and broke as an esbuild bundle syntax error on browsers).
  await FS.writeFile(Path.join(projDir, "package.json"),
    JSON.stringify({name: "p", version: "1.0.0", type: "commonjs"}));

  const refusal = await packageTypeRefusal(projDir);
  expect(refusal).toMatch(/"type": "commonjs"/);
  expect(refusal).toMatch(/"type": "module"/); // the fix is stated

  // The refusal is whole-run: even a node-only invocation (which used to
  // work incidentally) is refused.
  await FS.writeFile(Path.join(projDir, "test", "a.test.ts"),
    'import {test} from "node:test";\nimport assert from "node:assert";\n' +
    'test("a", () => { assert.ok(true); });\n');
  expect(await runTests({cwd: projDir, platforms: ["node"], timeout: 30000})).toBe(false);

  // module-typed and UNTYPED packages are never refused (untyped packages
  // are classified by syntax everywhere - measured, not assumed).
  await FS.writeFile(Path.join(projDir, "package.json"),
    JSON.stringify({name: "p", version: "1.0.0", type: "module"}));
  expect(await packageTypeRefusal(projDir)).toBeNull();
  await FS.writeFile(Path.join(projDir, "package.json"),
    JSON.stringify({name: "p", version: "1.0.0"}));
  expect(await packageTypeRefusal(projDir)).toBeNull();
  // ...and no package.json at all (bare directory of tests).
  expect(await packageTypeRefusal(testDir)).toBeNull();

  await removeTempDir(testDir);
});

test("registration counting covers only/skip/todo/each (denominator accuracy)", async () => {
  const {wrapTestApi} = await import("../src/_snapshot.ts");

  // Fake runner API shaped like bun's: sub-methods that register.
  const fake = () => {
    const test: any = (_n: string, _f: () => void) => {};
    test.skip = (_n: string, _f?: () => void) => {};
    test.todo = (_n: string, _f?: () => void) => {};
    test.only = (_n: string, _f: () => void) => {};
    test.each = (_table: unknown[]) => (_n: string, _f: (...a: any[]) => void) => {};
    test.concurrent = (_n: string, _f: () => void) => {};
    return test;
  };
  const api = wrapTestApi({describe: fake(), test: fake(), it: fake()});

  // The counter emits its running total via console.log in a microtask;
  // capture it rather than exporting mutable state for tests to poke.
  const emitted: string[] = [];
  const realLog = console.log;
  console.log = (...args: any[]) => { emitted.push(args.join(" ")); };
  try {
    const before = await currentRegisteredTotal(emitted);
    api.test("plain", () => {});                      // +1
    api.test.skip("skipped", () => {});               // +1 (runtimes report it)
    api.test.todo("todo");                            // +1
    api.test.only("only", () => {});                  // +1
    api.test.each([1, 2, 3])("row %i", () => {});     // +3 (one per row)
    api.test.concurrent("conc", () => {});            // +1 (body runs, tracked)
    api.describe("suite", () => { api.it("inner", () => {}); }); // +1, describe itself +0
    const after = await currentRegisteredTotal(emitted);
    expect(after - before).toBe(9);
    // Drain any pending debounced emit while capture is still on, so no
    // marker line leaks into the suite's own output after restore.
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    console.log = realLog;
  }

  // Reads the most recent emitted total (the counter is cumulative across the
  // process; deltas are what's meaningful here).
  async function currentRegisteredTotal(lines: string[]): Promise<number> {
    api.test("tick", () => {}); // force an emit
    await new Promise((r) => setTimeout(r, 0));      // let the microtask drain
    const markers = lines.filter((l) => l.startsWith("__LIBUILD_REGISTERED__"));
    return parseInt(markers[markers.length - 1].split(" ")[1], 10) - 1; // minus the tick
  }
});

test("import.meta.url/dirname/filename point at the source file, not the bundle", async () => {
  const testDir = await createTempDir("import-meta");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "tests", "fixtures"), {recursive: true});
  await FS.writeFile(Path.join(projDir, "package.json"),
    JSON.stringify({name: "p", version: "1.0.0", type: "module"}));
  await FS.writeFile(Path.join(projDir, "tests", "fixtures", "data.json"), '{"answer": 42}\n');
  // The mainstream pattern bundling used to break silently: fixtures next to
  // the test, addressed via import.meta. Failures surfaced deep inside the
  // code under test ("0 files parsed") and read as its bugs, not libuild's.
  await FS.writeFile(Path.join(projDir, "tests", "paths.test.js"),
    'import {test} from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    'import {readFileSync} from "node:fs";\n' +
    'test("dirname is the source dir", () => {\n' +
    '  assert.ok(!import.meta.dirname.includes(".libuild-test"), import.meta.dirname);\n' +
    '  assert.ok(import.meta.filename.endsWith("paths.test.js"), import.meta.filename);\n' +
    '});\n' +
    'test("fixture loads relative to the test file", () => {\n' +
    '  const data = JSON.parse(readFileSync(new URL("./fixtures/data.json", import.meta.url), "utf-8"));\n' +
    '  assert.equal(data.answer, 42);\n' +
    '});\n');

  expect(await runTests({cwd: projDir, platforms: ["node"], timeout: 30000})).toBe(true);

  await removeTempDir(testDir);
});

test("a helper file that registers no tests counts as 0 passed, not 1", () => {
  // node fabricates one passing test named with the file path when a file
  // registers nothing, and includes it in "# pass" - so shared helpers under
  // the test glob showed as "1 passed". The synthetic entry is recognized by
  // the bundle basename and excluded from both the tally and the summary.
  const tap = `TAP version 13
# Subtest: /tmp/x/.libuild-test/bundle-node-3.js
ok 1 - /tmp/x/.libuild-test/bundle-node-3.js
  ---
  duration_ms: 20
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 21
`;
  const r = parseTapOutput(tap, "bundle-node-3.js");
  expect(r.passed).toBe(0);
  expect(r.failed).toBe(0);
  expect(r.completed).toBe(true); // an empty file is still a completed run

  // Without the synthetic name (bun path, or older transcripts), behavior is
  // unchanged; and a REAL test file's counts are untouched because node emits
  // no synthetic entry when actual tests exist.
  expect(parseTapOutput(tap).passed).toBe(1);
  expect(parseTapOutput(NODE_TAP, "bundle-node-0.js").passed).toBe(1);
  expect(parseTapOutput(NODE_TAP, "bundle-node-0.js").failed).toBe(2);
});

test("a describe-callback throw fails the node run end-to-end (#23)", async () => {
  const testDir = await createTempDir("suite-throw-e2e");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  // The exact crank shape: the throw sits inside a describe() callback, node
  // exits 0 with "# fail 0", and 0.2.17 reported this green with the
  // never-registered tests silently missing.
  await FS.writeFile(Path.join(projDir, "test", "boom.test.ts"),
    'import {describe, it} from "node:test";\nimport assert from "node:assert";\n' +
    'describe("outer", () => {\n' +
    '  it("passes", () => { assert.ok(1); });\n' +
    '  describe("broken", () => { throw new Error("BOOM"); });\n' +
    '  it("after", () => { assert.ok(1); });\n' +
    '});\n');

  expect(await runTests({cwd: projDir, platforms: ["node"], timeout: 30000})).toBe(false);

  await removeTempDir(testDir);
});

test("node backend it.each registers one test per row (#23)", async () => {
  const testDir = await createTempDir("node-each");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.writeFile(Path.join(projDir, "package.json"), JSON.stringify({name: "p", version: "1.0.0"}));
  await FS.mkdir(Path.join(projDir, "node_modules", "@b9g"), {recursive: true});
  await FS.symlink(Path.resolve(import.meta.dir, "../dist"), Path.join(projDir, "node_modules", "@b9g", "libuild"));

  // The API that bit crank: it.each inside describe(), on node where
  // node:test has no .each. The shim registers per-row through the ordinary
  // block; the failing row proves the bodies actually execute (a suite whose
  // rows never ran would be green).
  await FS.writeFile(Path.join(projDir, "test", "each.test.ts"),
    'import {describe, it, expect} from "@b9g/libuild/test";\n' +
    'describe("adds", () => {\n' +
    '  it.each([[1, 1, 2], [2, 2, 4], [3, 3, 7]])("%i + %i = %i", (a: number, b: number, sum: number) => {\n' +
    '    expect(a + b).toBe(sum);\n' +
    '  });\n' +
    '});\n');

  // The third row is wrong on purpose: 3 + 3 != 7. Two rows pass, one fails -
  // and the run is red, proving per-row registration AND execution.
  expect(await runTests({cwd: projDir, platforms: ["node"], timeout: 30000})).toBe(false);

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

test("interleaved concurrent bodies attribute snapshots to their own names", async () => {
  // The reason tracking is an AsyncContext.Variable and not a global: two
  // concurrent bodies interleave across awaits, and each matcher call must
  // see ITS test's name. With the old global, whichever body resumed last
  // owned the name and both snapshots filed under it.
  const testDir = await createTempDir("snap-concurrent");
  const file = Path.join(testDir, "conc.test.ts");
  (globalThis as any).__LIBUILD_SNAPSHOT_FILE__ = file;
  (globalThis as any).__LIBUILD_UPDATE_SNAPSHOTS__ = true;

  const api = wrapTestApi({
    describe: (_n: string, fn: () => void) => fn(),
    test: (_n: string, fn: any) => fn(), // returns the body's promise
    it: (_n: string, fn: any) => fn(),
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const alpha = api.test("alpha", async () => {
    await sleep(20);
    snapMatcher.call({}, "A-ONE");
    await sleep(20);
    snapMatcher.call({}, "A-TWO");
  });
  const beta = api.test("beta", async () => {
    await sleep(10);
    snapMatcher.call({}, "B-ONE");
    await sleep(25);
    snapMatcher.call({}, "B-TWO");
  });
  await Promise.all([alpha, beta]);

  const {path: snapPath} = snapshotPathFor(file);
  const saved = parseSnapshots(await FS.readFile(snapPath, "utf-8"));
  expect(saved.get("alpha 1")).toBe("A-ONE");
  expect(saved.get("alpha 2")).toBe("A-TWO");
  expect(saved.get("beta 1")).toBe("B-ONE");
  expect(saved.get("beta 2")).toBe("B-TWO");

  await removeTempDir(testDir);
});

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

  // Reading a branded getter (the primary bug) would throw right here. One
  // deliberate exception: newer bun makes reading `.only` THROW under CI
  // ("disabled in CI environments") - the proxy must preserve that exactly as
  // native, so under CI the assertion is "throws bun's message", not "is a
  // function".
  const expectSubMethod = (obj: any, key: string) => {
    try {
      expect(typeof obj[key]).toBe("function");
    } catch (error: any) {
      if (key === "only" && /disabled in CI/i.test(error?.message ?? "")) return;
      throw error;
    }
  };
  for (const key of ["todo", "skip", "only", "skipIf", "todoIf", "each"]) {
    expectSubMethod(api.test, key);
  }
  for (const key of ["skip", "only", "each"]) {
    expectSubMethod(api.describe, key);
  }
  // `.each` is branded at CALL time too; building a registrar from an EMPTY table
  // exercises that path without registering any tests.
  expect(typeof (api.test as any).each([])).toBe("function");
  expect(typeof (api.describe as any).each([])).toBe("function");
});

test("output parsers strip ANSI so forced color can't corrupt the counts", () => {
  // With color on, the runner sets FORCE_COLOR on the child, so bun/node wrap
  // their summaries in escape codes (e.g. bun prints "\x1b[32m 3 pass\x1b[0m").
  // The count regexes anchor on line starts, which the codes would break - so
  // the parsers strip ANSI first. Feed them colorized summaries and assert the
  // numbers survive.
  const bun = "\x1b[0m\x1b[32m 3 pass\x1b[0m\n\x1b[0m\x1b[31m 2 fail\x1b[0m\n";
  const b = parseBunOutput(bun);
  expect(b.passed).toBe(3);
  expect(b.failed).toBe(2);
  expect(b.completed).toBe(true);

  const tap = "\x1b[32m# pass 5\x1b[0m\n\x1b[31m# fail 1\x1b[0m\n# tests 6\n";
  const t = parseTapOutput(tap);
  expect(t.passed).toBe(5);
  expect(t.failed).toBe(1);
  expect(t.completed).toBe(true);
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
