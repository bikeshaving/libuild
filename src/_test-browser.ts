/**
 * Browser test shim for @b9g/libuild/test
 *
 * Implements a minimal test runner that works in browsers.
 * Results are exposed via globalThis.__LIBUILD_TEST__ for Playwright to poll.
 */

/**
 * Minimal browser-compatible expect implementation
 */
class ExpectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectError";
  }
}

function stringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key]
    )
  );
}

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeNaN(): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toContain(expected: unknown): void;
  toHaveLength(expected: number): void;
  toMatch(expected: RegExp | string): void;
  toThrow(expected?: string | RegExp | Error): void;
  toBeInstanceOf(expected: new (...args: any[]) => any): void;
  toMatchSnapshot(hint?: string): void;
  not: Matchers;
}

function createMatchers(actual: unknown, negated = false): Matchers {
  const assert = (pass: boolean, message: string, negatedMessage: string) => {
    const shouldPass = negated ? !pass : pass;
    if (!shouldPass) {
      throw new ExpectError(negated ? negatedMessage : message);
    }
  };

  const matchers: Matchers = {
    toBe(expected: unknown) {
      assert(
        actual === expected,
        `Expected ${stringify(actual)} to be ${stringify(expected)}`,
        `Expected ${stringify(actual)} not to be ${stringify(expected)}`
      );
    },
    toEqual(expected: unknown) {
      assert(
        deepEqual(actual, expected),
        `Expected ${stringify(actual)} to equal ${stringify(expected)}`,
        `Expected ${stringify(actual)} not to equal ${stringify(expected)}`
      );
    },
    toStrictEqual(expected: unknown) {
      assert(
        deepEqual(actual, expected),
        `Expected ${stringify(actual)} to strictly equal ${stringify(expected)}`,
        `Expected ${stringify(actual)} not to strictly equal ${stringify(expected)}`
      );
    },
    toBeTruthy() {
      assert(
        Boolean(actual),
        `Expected ${stringify(actual)} to be truthy`,
        `Expected ${stringify(actual)} not to be truthy`
      );
    },
    toBeFalsy() {
      assert(
        !actual,
        `Expected ${stringify(actual)} to be falsy`,
        `Expected ${stringify(actual)} not to be falsy`
      );
    },
    toBeNull() {
      assert(
        actual === null,
        `Expected ${stringify(actual)} to be null`,
        `Expected ${stringify(actual)} not to be null`
      );
    },
    toBeUndefined() {
      assert(
        actual === undefined,
        `Expected ${stringify(actual)} to be undefined`,
        `Expected ${stringify(actual)} not to be undefined`
      );
    },
    toBeDefined() {
      assert(
        actual !== undefined,
        `Expected ${stringify(actual)} to be defined`,
        `Expected ${stringify(actual)} not to be defined`
      );
    },
    toBeNaN() {
      assert(
        Number.isNaN(actual),
        `Expected ${stringify(actual)} to be NaN`,
        `Expected ${stringify(actual)} not to be NaN`
      );
    },
    toBeGreaterThan(expected: number) {
      assert(
        (actual as number) > expected,
        `Expected ${stringify(actual)} to be greater than ${expected}`,
        `Expected ${stringify(actual)} not to be greater than ${expected}`
      );
    },
    toBeGreaterThanOrEqual(expected: number) {
      assert(
        (actual as number) >= expected,
        `Expected ${stringify(actual)} to be greater than or equal to ${expected}`,
        `Expected ${stringify(actual)} not to be greater than or equal to ${expected}`
      );
    },
    toBeLessThan(expected: number) {
      assert(
        (actual as number) < expected,
        `Expected ${stringify(actual)} to be less than ${expected}`,
        `Expected ${stringify(actual)} not to be less than ${expected}`
      );
    },
    toBeLessThanOrEqual(expected: number) {
      assert(
        (actual as number) <= expected,
        `Expected ${stringify(actual)} to be less than or equal to ${expected}`,
        `Expected ${stringify(actual)} not to be less than or equal to ${expected}`
      );
    },
    toContain(expected: unknown) {
      const contains = Array.isArray(actual)
        ? actual.includes(expected)
        : typeof actual === "string" && typeof expected === "string"
          ? actual.includes(expected)
          : false;
      assert(
        contains,
        `Expected ${stringify(actual)} to contain ${stringify(expected)}`,
        `Expected ${stringify(actual)} not to contain ${stringify(expected)}`
      );
    },
    toHaveLength(expected: number) {
      const len = (actual as { length: number }).length;
      assert(
        len === expected,
        `Expected length ${len} to be ${expected}`,
        `Expected length ${len} not to be ${expected}`
      );
    },
    toMatch(expected: RegExp | string) {
      const regex = typeof expected === "string" ? new RegExp(expected) : expected;
      assert(
        regex.test(actual as string),
        `Expected ${stringify(actual)} to match ${expected}`,
        `Expected ${stringify(actual)} not to match ${expected}`
      );
    },
    toThrow(expected?: string | RegExp | Error) {
      let threw = false;
      let error: unknown;
      try {
        (actual as () => void)();
      } catch (e) {
        threw = true;
        error = e;
      }
      if (expected === undefined) {
        assert(
          threw,
          `Expected function to throw`,
          `Expected function not to throw`
        );
      } else if (typeof expected === "string") {
        assert(
          threw && (error as Error).message.includes(expected),
          `Expected function to throw error containing "${expected}"`,
          `Expected function not to throw error containing "${expected}"`
        );
      } else if (expected instanceof RegExp) {
        assert(
          threw && expected.test((error as Error).message),
          `Expected function to throw error matching ${expected}`,
          `Expected function not to throw error matching ${expected}`
        );
      } else if (expected instanceof Error) {
        assert(
          threw && (error as Error).message === expected.message,
          `Expected function to throw ${expected.message}`,
          `Expected function not to throw ${expected.message}`
        );
      }
    },
    toBeInstanceOf(expected: new (...args: any[]) => any) {
      assert(
        actual instanceof expected,
        `Expected ${stringify(actual)} to be instance of ${expected.name}`,
        `Expected ${stringify(actual)} not to be instance of ${expected.name}`
      );
    },
    toMatchSnapshot() {
      // No filesystem in the browser: portable snapshots (bun/node) can't be
      // read/written here. Fail loudly rather than silently pass.
      throw new ExpectError(
        "toMatchSnapshot() is not supported on the browser platform; snapshots run on bun and node only"
      );
    },
    get not() {
      return createMatchers(actual, !negated);
    },
  };

  return matchers;
}

export function expect(actual: unknown): Matchers {
  return createMatchers(actual);
}

// Global state for playwright to poll
declare global {
  var __LIBUILD_TEST__: {
    ended: boolean;
    failed: number;
    passed: number;
    skipped: number;
    errors: Array<{ name: string; error: string }>;
  };
  var __LIBUILD_TEST_READY__: boolean | undefined;
}

globalThis.__LIBUILD_TEST__ = {
  ended: false,
  failed: 0,
  passed: 0,
  skipped: 0,
  errors: [],
};

type TestFn = () => void | Promise<void>;
type HookFn = () => void | Promise<void>;

interface Test {
  name: string;
  fn: TestFn;
  suite: Suite;
}

interface Suite {
  name: string;
  parent: Suite | null;
  beforeAll: HookFn[];
  afterAll: HookFn[];
  beforeEach: HookFn[];
  afterEach: HookFn[];
}

const tests: Test[] = [];
const rootSuite: Suite = {
  name: "",
  parent: null,
  beforeAll: [],
  afterAll: [],
  beforeEach: [],
  afterEach: [],
};
let currentSuite = rootSuite;

export function describe(name: string, fn: () => void) {
  const suite: Suite = {
    name,
    parent: currentSuite,
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: [],
  };
  const prev = currentSuite;
  currentSuite = suite;
  fn();
  currentSuite = prev;
}

export function test(name: string, fn: TestFn) {
  tests.push({ name, fn, suite: currentSuite });
}

// skip/todo register nothing but must EXIST: a file shared with node/bun that
// calls test.skip would otherwise die with a TypeError mid-module, aborting
// every registration after it in the single browser bundle (the tests before
// the throw still ran, so the run stayed green with tests missing). They tally
// into `skipped` so the result reflects that tests were deliberately not run.
function registerSkip(_name: string, _fn?: TestFn) {
  globalThis.__LIBUILD_TEST__.skipped++;
}
test.skip = registerSkip;
test.todo = registerSkip;
describe.skip = function (_name: string, _fn?: () => void) {
  // The body is NOT evaluated, so inner tests neither run nor tally - we
  // can't count what never registers, and evaluating the body just to count
  // would run consumer code that .skip promises not to run.
  globalThis.__LIBUILD_TEST__.skipped++;
};

export const it = test;

export function beforeEach(fn: HookFn) {
  currentSuite.beforeEach.push(fn);
}

export function afterEach(fn: HookFn) {
  currentSuite.afterEach.push(fn);
}

export function beforeAll(fn: HookFn) {
  currentSuite.beforeAll.push(fn);
}

export function afterAll(fn: HookFn) {
  currentSuite.afterAll.push(fn);
}

// Collect suite chain for a test
function getSuiteChain(suite: Suite): Suite[] {
  const chain: Suite[] = [];
  let s: Suite | null = suite;
  while (s) {
    chain.unshift(s);
    s = s.parent;
  }
  return chain;
}

// Get full test name
function getFullName(t: Test): string {
  const chain = getSuiteChain(t.suite);
  const names = chain.map((s) => s.name).filter(Boolean);
  names.push(t.name);
  return names.join(" > ");
}

// Auto-run after all modules loaded. The start signal is the generated
// entry's __LIBUILD_TEST_READY__ flag, set as the entry's LAST statement: ESM
// guarantees that statement runs only after every imported test file has
// fully evaluated - including top-level-await continuations spanning any
// number of macrotasks. Scheduler-based starts all lose some race with TLA:
// queueMicrotask fired before the dispatcher's TLA continuations ran any
// test-file body (green empty run, crank PR #375), and setTimeout still lost
// to a test file whose own TLA crossed a macrotask (fetch, timers) - its
// later tests silently vanished from a green run. Waiting on the flag is the
// only ordering the module system actually promises. If the entry throws
// before setting it, the flag never appears, `ended` never fires, and the
// harness reports the page errors it captured - loud, not green.
setTimeout(async () => {
  while (!globalThis.__LIBUILD_TEST_READY__) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const suiteRan = new Set<Suite>();

  // Indexed sweep, not for..of: anything that registers DURING the run (a
  // test body or hook adding tests) extends `tests` and is picked up. After
  // draining, wait one macrotask and re-check - a fire-and-forget late
  // registration (setTimeout in a module body) lands in the sweep instead of
  // silently missing the run.
  let index = 0;
  while (true) {
    if (index >= tests.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (index >= tests.length) break;
    }
    const t = tests[index++];
    const fullName = getFullName(t);
    const chain = getSuiteChain(t.suite);

    try {
      // Run beforeAll for suites that haven't run yet
      for (const suite of chain) {
        if (!suiteRan.has(suite)) {
          for (const hook of suite.beforeAll) await hook();
          suiteRan.add(suite);
        }
      }

      // Run beforeEach hooks (outer to inner)
      for (const suite of chain) {
        for (const hook of suite.beforeEach) await hook();
      }

      await t.fn();

      // Run afterEach hooks (inner to outer)
      for (const suite of [...chain].reverse()) {
        for (const hook of suite.afterEach) await hook();
      }

      console.log("✓", fullName);
      globalThis.__LIBUILD_TEST__.passed++;
    } catch (e: any) {
      console.error("✗", fullName);
      console.error("  ", e.message);
      globalThis.__LIBUILD_TEST__.failed++;
      globalThis.__LIBUILD_TEST__.errors.push({
        name: fullName,
        error: e.message || String(e),
      });
    }
  }

  // Run afterAll hooks for all suites (inner to outer)
  for (const suite of [...suiteRan].reverse()) {
    for (const hook of suite.afterAll) await hook();
  }

  globalThis.__LIBUILD_TEST__.ended = true;
});
