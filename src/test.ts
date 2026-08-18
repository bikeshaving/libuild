/**
 * @b9g/libuild/test - the single, platform-aware test API.
 *
 * This is the ONLY public test entrypoint. It detects the runtime and loads the
 * right backend: `bun:test` on Bun, `node:test` + the `expect` package on Node,
 * and a built-in runner on browsers. The backends are never exported - bun/node
 * use their own runtime builtins directly, and the browser runner is an internal
 * module (`internal/test-browser`, a chunk). From the package's perspective the only
 * visible test export is this file.
 *
 * On bun/node it also installs a PORTABLE `toMatchSnapshot` (see `internal/snapshot`)
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

async function loadNode() {
  const nodeTest = await import("node:test");
  const { expect } = await import("expect");
  // node:test's blocks are plain extensible functions. `.each` is supplied by
  // the snapshot wrapper for every runtime (so rows are tracked and counted
  // identically), but `.concurrent` is attached here where the runtime lacks
  // it: registering plainly is a conforming implementation of concurrent
  // semantics - concurrency is an optimization, not a guarantee - and it
  // keeps bun-authored suites running unchanged on node.
  for (const block of [nodeTest.describe, nodeTest.test, nodeTest.it] as any[]) {
    if (typeof block.concurrent !== "function") {
      block.concurrent = (...args: any[]) => (block as any)(...args);
    }
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
    ? await import("./internal/test-browser.js")
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
  const { installSnapshotMatcher, wrapTestApi } = await import("./internal/snapshot.js");
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
