/**
 * @b9g/libuild/test - the single, platform-aware test API.
 *
 * This is the ONLY public test entrypoint. It detects the runtime and loads the
 * right backend: `bun:test` on Bun, `node:test` + the `expect` package on Node,
 * and a built-in runner on browsers. The backends are never exported - bun/node
 * use their own runtime builtins directly, and the browser runner is an internal
 * module (`_test-browser`, a chunk). From the package's perspective the only
 * visible test export is this file.
 *
 * On bun/node it also installs a PORTABLE `toMatchSnapshot` (see `_snapshot`)
 * that overrides each runtime's native/absent snapshot support so `.snap` files
 * are identical across platforms, and wraps describe/test/it to track the
 * current test name for snapshot keys. Browsers have no filesystem, so the
 * browser runner's `toMatchSnapshot` throws.
 */

declare const Bun: unknown;

const isBun = typeof Bun !== "undefined";
// jsdom fakes `window`/`document` but runs inside Node, so `process` is still
// present; a real browser has none. That's the reliable node-vs-browser check
// (checking `window` would misfire for jsdom-based node tests).
const isBrowser = typeof process === "undefined";

/**
 * Format one `.each` row's test name, jest-style. Positional printf tokens
 * consume row values in order; `%#` is the row index; `%%` a literal percent.
 * Unrecognized tokens and leftover values are left alone (names are labels -
 * better a rough label than a throw during registration).
 */
function formatEachName(name: string, row: unknown[], index: number): string {
  let i = 0;
  return name.replace(/%[%#psdifjo]/g, (token) => {
    if (token === "%%") return "%";
    if (token === "%#") return String(index);
    const value = i < row.length ? row[i++] : undefined;
    if (token === "%p" || token === "%j" || token === "%o") {
      try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
    }
    if (token === "%d" || token === "%i" || token === "%f") return String(Number(value));
    return String(value);
  });
}

/**
 * `.each` for the node backend. bun:test/jest have it; node:test does not -
 * and its absence is the single most likely thing to bite a suite moving over
 * from `bun test`. Worse, the natural call sites sit inside describe()
 * callbacks, where the resulting `TypeError: it.each is not a function` used
 * to be swallowed entirely by node's TAP accounting (issue #23): nine call
 * sites in one real migration each registered zero tests, green. Each table
 * row registers one test through the given block, so downstream wrapping
 * (snapshot name-tracking, registration counting) sees ordinary calls.
 */
function eachFor(block: (name: string, fn: (...args: any[]) => unknown) => unknown) {
  return (table: unknown[]) => {
    if (!Array.isArray(table)) {
      throw new TypeError("each() expects an array table (template-literal tables are not supported)");
    }
    return (name: string, fn: (...args: any[]) => unknown) => {
      table.forEach((row, index) => {
        const args = Array.isArray(row) ? row : [row];
        block(formatEachName(String(name), args, index), () => fn(...args));
      });
    };
  };
}

async function loadNode() {
  const nodeTest = await import("node:test");
  const { expect } = await import("expect");
  // node:test's blocks are plain extensible functions; attach `.each` only
  // where the runtime lacks it, so a future node:test implementation wins.
  for (const block of [nodeTest.describe, nodeTest.test, nodeTest.it] as any[]) {
    if (typeof block.each !== "function") block.each = eachFor(block);
  }
  return {
    describe: nodeTest.describe,
    test: nodeTest.test,
    it: nodeTest.it,
    expect,
    beforeAll: nodeTest.before,
    afterAll: nodeTest.after,
    beforeEach: nodeTest.beforeEach,
    afterEach: nodeTest.afterEach,
  };
}

const backend = isBun
  ? await import("bun:test")
  : isBrowser
    ? await import("./_test-browser.js")
    : await loadNode();

let describe = backend.describe;
let test = backend.test;
let it = backend.it;

// bun/node: register the portable snapshot matcher on this runtime's `expect`
// and swap in name-tracking describe/test/it. Browser: the shim's `expect`
// already carries a throwing `toMatchSnapshot`, and there's no filesystem, so
// there's nothing to install (guarding the dynamic import keeps the browser
// bundle from ever loading the fs-using snapshot chunk).
if (!isBrowser) {
  const { installSnapshotMatcher, wrapTestApi } = await import("./_snapshot.js");
  await installSnapshotMatcher(backend.expect);
  const wrapped = wrapTestApi({ describe, test, it });
  describe = wrapped.describe;
  test = wrapped.test;
  it = wrapped.it;
}

const { beforeAll, afterAll, beforeEach, afterEach } = backend;

// The exported `expect` is typed as the `expect` package's, augmented with the
// portable `toMatchSnapshot`. At runtime it's bun's expect on Bun, the expect
// package on Node, or the browser shim - all compatible for the cross-platform
// matcher surface. (Runtime-specific matchers aren't surfaced in the type,
// which is intentional: only portable ones should be used.)
declare module "expect" {
  interface Matchers<R extends void | Promise<void>, T = unknown> {
    toMatchSnapshot(hint?: string): R;
  }
}
const expect = backend.expect as unknown as typeof import("expect").expect;

export {
  describe,
  test,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
};
