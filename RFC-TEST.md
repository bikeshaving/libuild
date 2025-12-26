# RFC: `libuild test` - Cross-Platform Test Runner

## Summary

Add a `libuild test` command that runs tests across Bun, Node, and browsers using a unified API. Tests are always bundled first, ensuring you test what you ship.

## Motivation

Library authors need to verify their code works across runtimes:
- **Bun** - Fast development, but not universal
- **Node** - The deployment target for most
- **Browser** - Required for frontend libraries

Currently this requires:
- Different test files per platform (`.test.ts` vs `.node-test.ts`)
- Multiple test runners (bun test, node --test, playwright-test)
- Manual shims for API differences (bun:test vs node:test vs custom)

## Proposal

### User API

```typescript
// test/example.test.ts
import { test, describe, expect, beforeEach } from "@b9g/libuild/test";

describe("math", () => {
  test("adds numbers", () => {
    expect(1 + 1).toBe(2);
  });

  test("async works", async () => {
    const result = await Promise.resolve(42);
    expect(result).toBe(42);
  });
});
```

### CLI

```bash
# Run on default platform (bun if available, else node)
libuild test

# Run on specific platform(s)
libuild test --bun
libuild test --node
libuild test --browser

# Multiple platforms
libuild test --node --browser

# All platforms
libuild test --all

# Specific files
libuild test test/unit/*.test.ts
```

### How It Works

```
libuild test --node --browser

1. Discover test files (glob **/*.test.ts)
2. Generate entry point (imports all test files)
3. Bundle with esbuild:
   - Replace "@b9g/libuild/test" with platform shim
   - Output: .libuild-test/bundle-{platform}.js
4. Run on each platform:
   - Node: node --test .libuild-test/bundle-node.js
   - Browser: launch playwright, serve bundle, collect results
5. Report combined results
```

## Platform Shims

**`@b9g/libuild/test`** exports:
- `test(name, fn)` / `it(name, fn)`
- `describe(name, fn)`
- `expect(value)` - from `expect` npm package (Jest's standalone)
- `beforeEach(fn)` / `afterEach(fn)`
- `beforeAll(fn)` / `afterAll(fn)`

### Bun Shim (`test-bun.ts`)

```typescript
export * from "bun:test";
```

### Node Shim (`test-node.ts`)

```typescript
import { describe, test, it, beforeEach, afterEach, before, after } from "node:test";
export { expect } from "expect";
export { describe, test, it, beforeEach, afterEach };
export { before as beforeAll, after as afterAll };
```

### Browser Shim (`test-browser.ts`)

```typescript
export { expect } from "expect";

// Global state for playwright to poll
declare global {
  var PW_TEST: { ended: boolean; failed: number; passed: number };
}
globalThis.PW_TEST = { ended: false, failed: 0, passed: 0 };

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
  afterEach: []
};
let currentSuite = rootSuite;

export function describe(name: string, fn: () => void) {
  const suite: Suite = {
    name,
    parent: currentSuite,
    beforeAll: [],
    afterAll: [],
    beforeEach: [],
    afterEach: []
  };
  const prev = currentSuite;
  currentSuite = suite;
  fn();
  currentSuite = prev;
}

export function test(name: string, fn: TestFn) {
  tests.push({ name, fn, suite: currentSuite });
}

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
  const names = chain.map(s => s.name).filter(Boolean);
  names.push(t.name);
  return names.join(" > ");
}

// Auto-run after all modules loaded
queueMicrotask(async () => {
  const suiteRan = new Set<Suite>();

  for (const t of tests) {
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
      globalThis.PW_TEST.passed++;
    } catch (e: any) {
      console.error("✗", fullName);
      console.error(" ", e.message);
      globalThis.PW_TEST.failed++;
    }
  }

  // Run afterAll hooks for all suites (inner to outer)
  for (const suite of [...suiteRan].reverse()) {
    for (const hook of suite.afterAll) await hook();
  }

  globalThis.PW_TEST.ended = true;
});
```

## Bundle Strategy

Always bundle tests before running:

```typescript
await esbuild.build({
  entryPoints: [generatedEntryPoint],
  bundle: true,
  platform: target === "browser" ? "browser" : "node",
  format: "esm",
  outfile: `.libuild-test/bundle-${target}.js`,
  alias: {
    "@b9g/libuild/test": resolve(`./src/test-${target}.js`),
  },
  external: target === "node" ? ["node:test", "node:assert"] : [],
});
```

**Why always bundle:**
- Tests run against the same code users will import
- Catches bundling issues (missing exports, circular deps)
- Consistent behavior across platforms
- TypeScript just works

## Browser Runner

Uses Playwright (peer dependency):

```typescript
import { chromium } from "playwright";
import { createServer } from "http";
import { readFile } from "fs/promises";

async function runBrowserTests(bundlePath: string): Promise<{ passed: number; failed: number }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!DOCTYPE html>
        <html>
          <head><script type="module" src="/bundle.js"></script></head>
          <body></body>
        </html>`);
    } else if (req.url === "/bundle.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(await readFile(bundlePath));
    }
  });

  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as any).port;

  const browser = await chromium.launch();
  const page = await browser.newPage();

  page.on("console", msg => console.log(msg.text()));

  await page.goto(`http://localhost:${port}`);
  await page.waitForFunction(
    () => globalThis.PW_TEST?.ended === true,
    { timeout: 60000, polling: 100 }
  );

  const results = await page.evaluate(() => globalThis.PW_TEST);

  await browser.close();
  server.close();

  return results;
}
```

## Configuration

In `package.json`:

```json
{
  "libuild": {
    "test": {
      "include": ["test/**/*.test.ts", "src/**/*.test.ts"],
      "exclude": ["**/*.browser.test.ts"],
      "browser": {
        "include": ["test/**/*.browser.test.ts"]
      },
      "timeout": 30000
    }
  }
}
```

## Output

```
$ libuild test --node --browser

Building tests...
  Bundled 15 test files

Node
  ✓ math > adds numbers
  ✓ math > async works
  ✓ strings > concatenates
  ✗ strings > handles unicode
    Expected "héllo" to equal "hello"

  14 passed, 1 failed

Browser (chromium)
  ✓ math > adds numbers
  ✓ math > async works
  ✓ strings > concatenates
  ✓ strings > handles unicode

  15 passed, 0 failed

Summary
  Node:    14/15
  Browser: 15/15
```

## Dependencies

| Package | Type | Size | Purpose |
|---------|------|------|---------|
| expect | dependency | ~50KB | Jest's matchers |
| playwright | peerDependency | ~50MB | Browser testing (optional) |
| esbuild | existing | - | Bundling |

## Open Questions

1. **Watch mode** - Rebuild and re-run on file changes?
2. **Coverage** - Integrate v8 coverage?
3. **Parallel** - Run platforms concurrently?
4. **Snapshots** - Support `toMatchSnapshot()`?
5. **Multiple browsers** - Firefox, WebKit via `--browser=firefox`?

## Implementation Plan

1. Add `expect` as dependency
2. Create shims: `test-bun.ts`, `test-node.ts`, `test-browser.ts`
3. Export `@b9g/libuild/test` entry point
4. Add `libuild test` CLI command
5. Implement test bundling
6. Implement Node runner
7. Implement Browser runner
8. Documentation

## References

- [playwright-test](https://github.com/hugomrdias/playwright-test) - Prior art
- [expect](https://www.npmjs.com/package/expect) - Jest's standalone matchers
- [bun:test](https://bun.sh/docs/cli/test) - API we're matching
- [node:test](https://nodejs.org/api/test.html) - Node's native runner
