/**
 * Node.js test shim for @b9g/libuild/test
 *
 * Combines node:test runner with Jest's expect matchers.
 */

import {
  describe,
  test,
  it,
  before,
  after,
  beforeEach,
  afterEach,
} from "node:test";

// Re-export expect from jest's standalone package
export { expect } from "expect";

// Re-export node:test primitives
export {
  describe,
  test,
  it,
  before as beforeAll,
  after as afterAll,
  beforeEach,
  afterEach,
};
