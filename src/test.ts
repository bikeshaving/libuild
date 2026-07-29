/**
 * @b9g/libuild/test - the single, platform-aware test API.
 *
 * This is the ONLY public test entrypoint. It detects the runtime and loads the
 * right backend: `bun:test` on Bun, `node:test` + the `expect` package on Node,
 * and a built-in runner on browsers. The backends are never exported - bun/node
 * use their own runtime builtins directly, and the browser runner is an internal
 * module (`_test-browser`, a chunk). From the package's perspective the only
 * visible test export is this file.
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

const {
  describe,
  test,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} = isBun
  ? await import("bun:test")
  : isBrowser
    ? await import("./_test-browser.js")
    : await loadNode();

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
