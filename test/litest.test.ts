import {test, expect} from "../src/test.ts";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/internal/libuild.ts";
import {findInSourceTestFiles} from "../src/internal/test-runner.ts";
import {LITEST_GUARD, LITEST_MARKER} from "../src/plugins/litest.ts";
import {createTempDir, removeTempDir} from "./test-utils.ts";

// In-source tests: blocks guarded on the litest marker, written next to the
// code they cover. The library build must erase them completely - the point of
// the feature is that the published package cannot tell they were ever there.

const PKG = (name: string) =>
  JSON.stringify({name, version: "0.0.1", type: "module"}, null, 2);

/** A module whose in-source test reaches state that is never exported. */
const WITH_TESTS = `
const SEEN = new Map<string, number>();

function memoKey(a: number, b: number) { return \`\${a}:\${b}\`; }

export function add(a: number, b: number) { return a + b; }

export function addMemo(a: number, b: number) {
  const key = memoKey(a, b);
  if (SEEN.has(key)) { return SEEN.get(key)!; }
  const out = add(a, b);
  SEEN.set(key, out);
  return out;
}

if (${LITEST_MARKER}) {
  const {test, expect} = ${LITEST_MARKER};
  test("add", () => { expect(add(1, 2)).toBe(3); });
  test("private state", () => { expect(memoKey(1, 2)).toBe("1:2"); });
}
`;

/** The same shape, with no in-source tests: the untouched control. */
const WITHOUT_TESTS = `
const CACHE = new Map<string, number>();

export function tally(xs: string[]) {
  let total = 0;
  for (const x of xs) {
    if (x.startsWith("_")) {
      continue;
    }
    total += x.length;
  }
  CACHE.set("last", total);
  return total;
}
`;

// Temp directory names deliberately avoid the marker word: esbuild writes the
// source path into a header comment, which would satisfy a naive
// `toContain("litest")` and hide a real leak.
async function scaffold(name: string, files: Record<string, string>) {
  const dir = await createTempDir(name);
  await FS.mkdir(Path.join(dir, "src"), {recursive: true});
  await FS.writeFile(Path.join(dir, "package.json"), PKG(name));
  for (const [rel, contents] of Object.entries(files)) {
    const target = Path.join(dir, "src", rel);
    await FS.mkdir(Path.dirname(target), {recursive: true});
    await FS.writeFile(target, contents);
  }
  return dir;
}

test("build erases the in-source test block", async () => {
  const dir = await scaffold("insrc-strip", {"math.ts": WITH_TESTS});
  try {
    await build(dir);
    const out = await FS.readFile(Path.join(dir, "dist", "math.js"), "utf-8");

    // The block, its assertions, and any trace of the API are gone.
    expect(out).not.toContain("litest");
    expect(out).not.toContain("expect");
    expect(out).not.toContain("toBe");

    // Critically: no import of the test framework survives. If one did, every
    // consumer of the published package would need libuild installed to load
    // this module at all.
    expect(out).not.toContain("@b9g/libuild");

    // The library itself is untouched, including the private helper the
    // exported function still needs.
    expect(out).toContain("function add");
    expect(out).toContain("function memoKey");
  } finally {
    await removeTempDir(dir);
  }
}, 60000);  // builds a fixture - beyond bun's 5s default under load

test("a module with no in-source tests keeps its unminified shape", async () => {
  const dir = await scaffold("insrc-untouched", {"plain.ts": WITHOUT_TESTS});
  try {
    await build(dir);
    const out = await FS.readFile(Path.join(dir, "dist", "plain.js"), "utf-8");

    // Stripping costs a syntax rewrite, so it runs per FILE and only where a
    // test block actually is. A package that never writes one must not pay:
    // braces, `continue`, and separate statements all survive here, where an
    // over-broad `minifySyntax` would have collapsed them.
    expect(out).toContain("continue;");
    expect(out).toContain("CACHE.set(\"last\", total);");
    expect(out).toContain("return total;");
  } finally {
    await removeTempDir(dir);
  }
}, 60000);  // builds a fixture - beyond bun's 5s default under load

test("stripping reaches bundled modules, not just entrypoints", async () => {
  // Every top-level src file is its own entrypoint, so a nested module is what
  // actually exercises the bundled path: its code is inlined into the importer,
  // and the test block has to be gone from THAT output too.
  const dir = await scaffold("insrc-nested", {
    "index.ts": `export {add, addMemo} from "./internal/math.js";\n`,
    "internal/math.ts": WITH_TESTS,
  });
  try {
    await build(dir);
    const out = await FS.readFile(Path.join(dir, "dist", "index.js"), "utf-8");
    expect(out).toContain("function add");
    expect(out).not.toContain("litest");
    expect(out).not.toContain("toBe");
    expect(out).not.toContain("@b9g/libuild");
  } finally {
    await removeTempDir(dir);
  }
}, 60000);  // builds a fixture - beyond bun's 5s default under load

test("discovery finds source files carrying a guard", async () => {
  const dir = await scaffold("insrc-discovery", {
    "math.ts": WITH_TESTS,
    "plain.ts": WITHOUT_TESTS,
  });
  try {
    const found = await findInSourceTestFiles(dir);
    expect(found.map((f) => Path.basename(f))).toEqual(["math.ts"]);
  } finally {
    await removeTempDir(dir);
  }
});

test("discovery ignores a file that only mentions the property in prose", async () => {
  // The modules implementing this feature document it, so a bare substring
  // scan would discover them as test suites and bundle esbuild and node:fs
  // into a browser test run. Only a real guard counts.
  const dir = await scaffold("insrc-prose", {
    "docs.ts": `/** Guarded by ${LITEST_MARKER}, which the build strips. */\nexport const NOTE = 1;\n`,
  });
  try {
    expect(await findInSourceTestFiles(dir)).toEqual([]);
  } finally {
    await removeTempDir(dir);
  }
});

test("the guard matches its spellings and nothing else", () => {
  // Spelled through the marker, never literally: a literal guard here makes
  // this file discover itself (see the test below).
  expect(LITEST_GUARD.test(`if (${LITEST_MARKER}) {`)).toBe(true);
  expect(LITEST_GUARD.test(`if(${LITEST_MARKER}){`)).toBe(true);
  expect(LITEST_GUARD.test(`if ( ${LITEST_MARKER} ) {`)).toBe(true);
  expect(LITEST_GUARD.test(`// see ${LITEST_MARKER} for details`)).toBe(false);
  expect(LITEST_GUARD.test(`const api = ${LITEST_MARKER};`)).toBe(false);
});

test("the modules implementing in-source tests are not themselves suites", async () => {
  // Guards this repository against the self-reference above: these files talk
  // about the marker constantly, and must stay out of their own discovery.
  const src = Path.join(process.cwd(), "src");
  const found = await findInSourceTestFiles(process.cwd());
  const names = found.map((f) => Path.relative(src, f));
  expect(names).not.toContain(Path.join("plugins", "litest.ts"));
  expect(names).not.toContain(Path.join("internal", "test-runner.ts"));
});

test("a source file can gate test-only code on the marker without being a suite", async () => {
  // termdom's case: checks that run in the frame loop under test and must
  // not ship. The file holds no in-source test, so it is not discovered as
  // a suite; an ordinary test file imports it, and in that test bundle the
  // marker is the test API, so the gated code runs.
  const dir = await createTempDir("insrc-gated");
  const projDir = Path.join(dir, "proj");
  await FS.mkdir(Path.join(projDir, "src"), {recursive: true});
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.mkdir(Path.join(projDir, "node_modules", "@b9g"), {recursive: true});
  await FS.writeFile(Path.join(projDir, "package.json"), PKG("insrc-gated"));
  const root = Path.resolve(import.meta.dirname, "..");
  await FS.symlink(Path.join(root, "dist"), Path.join(projDir, "node_modules", "@b9g", "libuild"));
  for (const dep of ["@b9g/async-context", "expect", "pretty-format"]) {
    const target = Path.join(root, "node_modules", dep);
    if (await FS.stat(target).then(() => true).catch(() => false)) {
      await FS.mkdir(Path.dirname(Path.join(projDir, "node_modules", dep)), {recursive: true});
      await FS.symlink(target, Path.join(projDir, "node_modules", dep));
    }
  }
  await FS.writeFile(Path.join(projDir, "src", "frame.ts"),
    "export const checks: string[] = [];\n" +
    "function layoutCheck() { checks.push(\"layout\"); }\n" +
    "export function frame() {\n" +
    `  if (${LITEST_MARKER} && checks.length < 3) { layoutCheck(); }\n` +
    "  return checks.length;\n" +
    "}\n");
  await FS.writeFile(Path.join(projDir, "test", "frame.test.ts"),
    'import {test, expect} from "@b9g/libuild/test";\n' +
    'import {frame} from "../src/frame.ts";\n' +
    'test("the gated check runs under test", () => { expect(frame()).toBe(1); });\n');

  try {
    expect(await findInSourceTestFiles(projDir)).toEqual([]);
    const {runTests} = await import("../src/internal/test-runner.ts");
    expect(await runTests({cwd: projDir, platforms: ["node"], timeout: 60000, concurrency: 1})).toBe(true);
    expect(await runTests({cwd: projDir, platforms: ["bun"], timeout: 60000, concurrency: 1})).toBe(true);

    // The build strips the gated call, and the check function with it.
    await build(projDir, false);
    const built = await FS.readFile(Path.join(projDir, "dist", "frame.js"), "utf-8");
    expect(built).not.toContain("layout");

    // A browser bundle gets the API import for the one file that needs it.
    const {bundleTests} = await import("../src/internal/test-runner.ts");
    const out = await createTempDir("insrc-gated-browser");
    const bundle = await FS.readFile(await bundleTests([Path.join(projDir, "test", "frame.test.ts")], "chromium", out, projDir), "utf-8");
    expect(bundle).toContain("layoutCheck");
    await removeTempDir(out);
  } finally {
    await removeTempDir(dir);
  }
}, 180000);

test("a source file gating code on the marker still gets its declaration", async () => {
  // The litest strip plugin claims every file holding the marker, and the
  // dts plugin collected its files from the onLoad calls it was still
  // allowed to see - so such a file shipped with no .d.ts, and the build
  // said nothing. termdom 0.2.1 went to npm without index.d.ts that way.
  const dir = await scaffold("insrc-dts", {
    "index.ts":
      "export const enabled = {on: true};\n" +
      "function check() { return 1; }\n" +
      "export function frame(): number {\n" +
      `  if (${LITEST_MARKER} && enabled.on) { check(); }\n` +
      "  return 2;\n" +
      "}\n",
  });
  try {
    await build(dir, false);
    const dts = await FS.readFile(Path.join(dir, "dist", "index.d.ts"), "utf-8");
    expect(dts).toContain("export declare function frame(): number;");
    expect(dts).not.toContain("litest");
    expect(dts).not.toContain("ImportMeta");
    const pkg = JSON.parse(await FS.readFile(Path.join(dir, "dist", "package.json"), "utf-8"));
    expect(pkg.exports["."].types).toBe("./index.d.ts");
  } finally {
    await removeTempDir(dir);
  }
}, 60000);

test("a type error does not cost a file its declaration", async () => {
  // tsc writes declarations despite type errors, and so does the build;
  // the error is reported as a warning rather than silently dropping a file.
  const dir = await scaffold("insrc-dts-error", {
    "index.ts": 'export const n: number = "not a number";\nexport function frame(): number { return 2; }\n',
  });
  try {
    await build(dir, false);
    const dts = await FS.readFile(Path.join(dir, "dist", "index.d.ts"), "utf-8");
    expect(dts).toContain("export declare const n: number;");
  } finally {
    await removeTempDir(dir);
  }
}, 60000);

test("this file is not itself discovered as a suite", async () => {
  // A literal guard here is enough to make the runner inject the litest shim
  // into this file's own bundle. The shim imports the test API, which in this
  // repository is a bundled path rather than an external package, so its
  // top-level await waits on a module that is waiting on the shim: the run
  // deadlocks under bun and exits unsettled under node. `bun test` never sees
  // it - only the self-hosted `test:all` does.
  const contents = await FS.readFile(new URL(import.meta.url).pathname, "utf-8");
  expect(LITEST_GUARD.test(contents)).toBe(false);
});
