/**
 * @b9g/libuild/test - Cross-platform test utilities
 *
 * Provides a unified testing API across Bun, Node, and browsers.
 * Uses top-level await to detect runtime and load appropriate shim.
 */

declare const Bun: unknown;

const isBun = typeof Bun !== "undefined";

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
  ? await import("./test-bun.js")
  : await import("./test-node.js");

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
