import {test, expect} from "../src/test.ts";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/internal/libuild.ts";
import {findInSourceTestFiles} from "../src/internal/test-runner.ts";
import {LITEST_GUARD, LITEST_MARKER} from "../src/plugins/litest.ts";
import {createTempDir, removeTempDir} from "./test-utils.ts";

// In-source tests: `if (import.meta.litest) { ... }` blocks written next to the
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
});

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
});

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
});

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
  expect(LITEST_GUARD.test("if (import.meta.litest) {")).toBe(true);
  expect(LITEST_GUARD.test("if(import.meta.litest){")).toBe(true);
  expect(LITEST_GUARD.test("if ( import.meta.litest ) {")).toBe(true);
  expect(LITEST_GUARD.test("// see import.meta.litest for details")).toBe(false);
  expect(LITEST_GUARD.test("const api = import.meta.litest;")).toBe(false);
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
