/**
 * Bun test shim for @b9g/libuild/test
 *
 * Simply re-exports bun:test which already has Jest-compatible APIs.
 */

export {
  describe,
  test,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
