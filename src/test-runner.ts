/**
 * @b9g/libuild test runner
 *
 * Cross-platform test execution for Bun, Node, and browsers.
 */

import * as FS from "fs/promises";
import * as Path from "path";
import { createServer, type Server } from "http";
import * as ESBuild from "esbuild";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = Path.dirname(fileURLToPath(import.meta.url));

export type Platform = "bun" | "node" | "chromium" | "firefox" | "webkit";

export interface TestRunnerOptions {
  /** Working directory */
  cwd: string;
  /** Test file patterns */
  patterns: string[];
  /** Platforms to run on (bun, node, chromium, firefox, webkit) */
  platforms: Platform[];
  /** Enable debug mode (keeps browser open) */
  debug: boolean;
  /** Test timeout in ms */
  timeout: number;
  /** Watch mode */
  watch: boolean;
}

export interface TestResult {
  platform: string;
  passed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
  skipped?: number;
  todo?: number;
}

const DEFAULT_PATTERNS = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/*.spec.jsx",
  "**/test/**/*.ts",
  "**/test/**/*.tsx",
  "**/test/**/*.js",
  "**/test/**/*.jsx",
];

const IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.git/**",
  "**/coverage/**",
];

/**
 * Find test files matching patterns
 */
async function findTestFiles(cwd: string, patterns: string[]): Promise<string[]> {
  const { glob } = await import("glob");

  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd,
      ignore: IGNORE_PATTERNS,
      absolute: true,
    });
    files.push(...matches);
  }

  // Deduplicate
  return [...new Set(files)];
}

/**
 * Locate the optional setup file: test/test-setup.{ts,tsx,js,jsx} at the root
 * of the test directory. A single global preload imported before all tests on
 * every platform (register beforeEach/afterEach, install polyfills, etc.);
 * switch behavior per-runtime inside it (`if (typeof Bun !== "undefined")`).
 * The `test-` prefix keeps it from colliding with a real test named setup.*,
 * since the runner's test-directory glob collects every .ts file under test/.
 */
async function findSetupFile(cwd: string): Promise<string | null> {
  for (const ext of ["ts", "tsx", "js", "jsx"]) {
    const candidate = Path.join(cwd, "test", `test-setup.${ext}`);
    try {
      await FS.access(candidate);
      return candidate;
    } catch {
      // not present, try next extension
    }
  }
  return null;
}

/**
 * Discover the test files and the optional setup file, excluding the setup
 * file from the test set (it's caught by the test-directory glob but is a
 * preload, not a test). Exported so discovery/exclusion is testable without
 * spawning.
 */
export async function collectTests(
  cwd: string,
  patterns: string[]
): Promise<{ testFiles: string[]; setupFile: string | null }> {
  const foundFiles = await findTestFiles(cwd, patterns);
  const setupFile = await findSetupFile(cwd);
  const resolvedSetup = setupFile ? await FS.realpath(setupFile) : null;

  const testFiles: string[] = [];
  for (const file of foundFiles) {
    if (resolvedSetup && (await FS.realpath(file)) === resolvedSetup) continue;
    testFiles.push(file);
  }

  return { testFiles, setupFile };
}

/**
 * Generate entry point that imports the setup file (if any) then all test files
 */
function generateTestEntry(testFiles: string[], platform: string, setupFile: string | null): string {
  const toImport = (file: string) => `import "${file.replace(/\\/g, "/")}";`;
  const lines: string[] = [];
  if (setupFile) {
    lines.push("// Setup file - runs before all tests");
    lines.push(toImport(setupFile));
  }
  lines.push(...testFiles.map(toImport));

  return `// Auto-generated test entry for ${platform}
${lines.join("\n")}
`;
}

/**
 * Check if platform is a browser
 */
function isBrowserPlatform(platform: Platform): platform is "chromium" | "firefox" | "webkit" {
  return platform === "chromium" || platform === "firefox" || platform === "webkit";
}

/**
 * Bundle tests for a specific platform.
 * Exported for tests that assert externalization behavior.
 */
export async function bundleTests(
  testFiles: string[],
  platform: Platform,
  outDir: string,
  cwd: string
): Promise<string> {
  const setupFile = await findSetupFile(cwd);
  const entryContent = generateTestEntry(testFiles, platform, setupFile);
  const entryPath = Path.join(outDir, `entry-${platform}.ts`);
  const outPath = Path.join(outDir, `bundle-${platform}.js`);

  await FS.writeFile(entryPath, entryContent);

  // Determine the shim path based on platform
  const isBrowser = isBrowserPlatform(platform);
  const shimName = isBrowser ? "test-browser" : `test-${platform}`;

  // For development, use source files; for installed package, use dist
  let shimPath: string;
  try {
    // Try to resolve from the package (installed mode)
    shimPath = require.resolve(`@b9g/libuild/${shimName}`);
  } catch {
    // Development mode - use relative path
    shimPath = Path.join(__dirname, `${shimName}.js`);
  }

  // For Node/Bun, we need to inject a require shim for CJS interop
  const requireShim = `
import { createRequire } from "module";
const require = createRequire(import.meta.url);
`;

  const buildOptions: ESBuild.BuildOptions = {
    entryPoints: [entryPath],
    bundle: true,
    format: "esm",
    outfile: outPath,
    platform: isBrowser ? "browser" : "node",
    target: isBrowser ? "es2020" : "node20",
    // Replace @b9g/libuild/test with platform-specific shim
    alias: {
      "@b9g/libuild/test": shimPath,
    },
    // node/bun resolve node_modules deps at runtime, so externalize them
    // instead of inlining. Bundling deps into the test harness is both
    // pointless (the runtime can require them) and actively broken for
    // bundle-hostile packages like jsdom (spawns a worker from a real
    // file, reads __dirname). It also matches how the *built* package runs
    // - packages: "external" is what the library build uses - so tests
    // exercise the same module graph and interop consumers get, instead of
    // esbuild's looser bundled interop. Browsers have no node_modules at
    // runtime, so they still need everything inlined. The @b9g/libuild/test
    // alias resolves to an absolute path and stays bundled regardless.
    ...(isBrowser ? {} : { packages: "external" as const }),
    // External runtime-specific modules
    external: platform === "bun" ? ["bun:test"] : [],
    // Inject require shim for node/bun to handle CJS deps like expect/chalk
    ...(isBrowser ? {} : { banner: { js: requireShim } }),
    // Define for dead code elimination
    define: {
      "process.env.NODE_ENV": '"test"',
    },
    logLevel: "warning",
  };

  await ESBuild.build(buildOptions);

  return outPath;
}

// A trailing TAP directive marks a test as todo or skipped, e.g.
// "not ok 5 - name # TODO" or "ok 3 - name # SKIP". These are NOT failures.
// The lookbehind ignores an escaped "\#", which node uses for a literal "#"
// inside a test description (so a test literally named "... # TODO" isn't
// mistaken for a directive).
const TAP_DIRECTIVE = /(?<!\\)#\s*(TODO|SKIP)\b/i;

/**
 * Parse TAP output to extract test results.
 * Node TAP output uses "type: 'test'" for actual tests vs "type: 'suite'" for
 * describe blocks, and marks todo/skip tests with a trailing directive. Prefer
 * node's authoritative summary lines (# pass / # fail / # todo / # skipped) for
 * the counts; fall back to a directive-aware per-test tally if they're absent.
 * Exported for unit testing.
 */
export function parseTapOutput(output: string): { passed: number; failed: number; errors: Array<{ name: string; error: string }>; skipped: number; todo: number; completed: boolean } {
  const errors: Array<{ name: string; error: string }> = [];
  const lines = output.split("\n");

  let lastTestName = "";
  let lastTestNotOk = false;
  let tallyPassed = 0;
  let tallyFailed = 0;
  let tallySkipped = 0;
  let tallyTodo = 0;

  for (const line of lines) {
    // TAP format: "ok 1 - test name" or "not ok 1 - test name"
    const okMatch = line.match(/^\s*ok \d+ - (.+)/);
    const notOkMatch = line.match(/^\s*not ok \d+ - (.+)/);

    if (okMatch) {
      lastTestName = okMatch[1];
      lastTestNotOk = false;
    } else if (notOkMatch) {
      lastTestName = notOkMatch[1];
      lastTestNotOk = true;
    }

    // Only tally on "type: 'test'" lines (skip describe-block "type: 'suite'")
    if (line.includes("type: 'test'") || line.includes('type: "test"')) {
      const directive = lastTestName.match(TAP_DIRECTIVE);
      const kind = directive ? directive[1].toUpperCase() : null;
      if (kind === "SKIP") {
        tallySkipped++;
      } else if (kind === "TODO") {
        tallyTodo++;
      } else if (lastTestNotOk) {
        tallyFailed++;
        errors.push({ name: lastTestName, error: "Test failed" });
      } else {
        tallyPassed++;
      }
    }
  }

  // Node's TAP reporter emits an authoritative summary; trust it for the counts
  // when present (the hand tally above still supplies failing-test names).
  const summary = (label: string): number | null => {
    const m = output.match(new RegExp(`^#\\s*${label}\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1], 10) : null;
  };

  // "completed" means the child actually ran to a result summary. A run that
  // was killed or crashed before finishing produces neither a `# tests` line
  // nor any `type: 'test'` line - it must not be mistaken for a clean 0/0 pass.
  const completed = summary("tests") !== null
    || (tallyPassed + tallyFailed + tallySkipped + tallyTodo) > 0;

  return {
    passed: summary("pass") ?? tallyPassed,
    failed: summary("fail") ?? tallyFailed,
    skipped: summary("skipped") ?? tallySkipped,
    todo: summary("todo") ?? tallyTodo,
    errors,
    completed,
  };
}

/**
 * A test run only counts as successfully completed if the child produced a
 * result summary AND was not killed by a signal (timeout / OOM). Otherwise it
 * must be treated as a failure, never a false green (issue #16).
 */
export function runCompleted(completed: boolean, signal: NodeJS.Signals | null): boolean {
  return completed && signal == null;
}

/**
 * Run tests in Node.js using node:test
 */
async function runNodeTests(bundlePath: string, timeout: number): Promise<TestResult> {
  const { spawn } = await import("child_process");

  return new Promise((resolve) => {
    const child = spawn("node", ["--test", "--test-reporter=tap", bundlePath], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";
    // Track pending test results for streaming output
    let pendingTest: { name: string; passed: boolean } | null = null;
    const printedTests = new Set<string>();

    child.stdout?.on("data", (data) => {
      const text = data.toString();
      stdout += text;

      // Stream output to console, converting TAP to readable format
      for (const line of text.split("\n")) {
        // Capture test result
        const okMatch = line.match(/^\s*ok \d+ - (.+)/);
        const notOkMatch = line.match(/^\s*not ok \d+ - (.+)/);

        if (okMatch) {
          pendingTest = { name: okMatch[1], passed: true };
        } else if (notOkMatch) {
          pendingTest = { name: notOkMatch[1], passed: false };
        }

        // When we see type: 'test', print the pending test
        if ((line.includes("type: 'test'") || line.includes('type: "test"')) && pendingTest) {
          const key = `${pendingTest.name}-${pendingTest.passed}`;
          if (!printedTests.has(key)) {
            printedTests.add(key);
            // A todo/skip directive isn't a failure - print it neutrally so a
            // green run doesn't stream false red ✗ marks.
            if (TAP_DIRECTIVE.test(pendingTest.name)) {
              console.log(`○ ${pendingTest.name}`);
            } else if (pendingTest.passed) {
              console.log(`✓ ${pendingTest.name}`);
            } else {
              console.log(`✗ ${pendingTest.name}`);
            }
          }
          pendingTest = null;
        }
      }
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    child.on("close", (code, signal) => {
      const { passed, failed, errors, skipped, todo, completed } = parseTapOutput(stdout);
      if (!runCompleted(completed, signal)) {
        // Killed (timeout/OOM) or crashed before producing a summary: this is a
        // failure, not a clean 0/0 pass (issue #16).
        const reason = signal != null ? `killed (${signal})` : `exited ${code ?? "?"} without completing`;
        resolve({
          platform: "node",
          passed,
          failed: Math.max(failed, 1),
          errors: [...errors, { name: `node test process ${reason}`, error: "test run did not complete (timeout, crash, or OOM)" }],
          skipped,
          todo,
        });
        return;
      }
      resolve({ platform: "node", passed, failed, errors, skipped, todo });
    });

    child.on("error", (err) => {
      resolve({
        platform: "node",
        passed: 0,
        failed: 1,
        errors: [{ name: "spawn error", error: err.message }],
      });
    });
  });
}

/**
 * Parse Bun test output to extract test results
 * Format: "N pass", "N fail"
 */
function parseBunOutput(output: string): { passed: number; failed: number; errors: Array<{ name: string; error: string }>; completed: boolean } {
  let passed = 0;
  let failed = 0;
  const errors: Array<{ name: string; error: string }> = [];

  // Match "N pass" and "N fail" lines
  const passMatch = output.match(/^\s*(\d+)\s+pass/m);
  const failMatch = output.match(/^\s*(\d+)\s+fail/m);

  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);

  // Bun always prints a "N pass"/"N fail" summary on a completed run; its
  // absence means the child was killed or crashed before finishing.
  const completed = passMatch !== null || failMatch !== null;

  return { passed, failed, errors, completed };
}

/**
 * Run tests in Bun
 */
async function runBunTests(bundlePath: string, timeout: number): Promise<TestResult> {
  const { spawn } = await import("child_process");

  return new Promise((resolve) => {
    const child = spawn("bun", ["test", bundlePath], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(data);
    });

    child.stderr?.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(data);
    });

    child.on("close", (code, signal) => {
      const { passed, failed, errors, completed } = parseBunOutput(stdout + stderr);
      if (!runCompleted(completed, signal)) {
        // Killed (timeout/OOM) or crashed before producing a summary: this is a
        // failure, not a clean 0/0 pass (issue #16).
        const reason = signal != null ? `killed (${signal})` : `exited ${code ?? "?"} without completing`;
        resolve({
          platform: "bun",
          passed,
          failed: Math.max(failed, 1),
          errors: [...errors, { name: `bun test process ${reason}`, error: "test run did not complete (timeout, crash, or OOM)" }],
        });
        return;
      }
      resolve({ platform: "bun", passed, failed, errors });
    });

    child.on("error", (err) => {
      resolve({
        platform: "bun",
        passed: 0,
        failed: 1,
        errors: [{ name: "spawn error", error: err.message }],
      });
    });
  });
}

/**
 * Run tests in browser using Playwright
 */
async function runBrowserTests(
  bundlePath: string,
  browser: "chromium" | "firefox" | "webkit",
  timeout: number,
  debug: boolean,
  cwd: string
): Promise<TestResult> {
  // Try to import playwright from the test project's node_modules
  let playwright: typeof import("playwright");
  try {
    // Create a require function that resolves from the test project
    const require = createRequire(Path.join(cwd, "package.json"));
    playwright = require("playwright");
  } catch {
    console.error("Playwright is required for browser tests.");
    console.error("Install it with: npm install -D playwright");
    return {
      platform: `browser (${browser})`,
      passed: 0,
      failed: 1,
      errors: [{ name: "setup", error: "Playwright not installed" }],
    };
  }

  const bundleContent = await FS.readFile(bundlePath, "utf-8");

  // Create a simple HTTP server to serve the test
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>libuild tests</title>
</head>
<body>
  <script type="module">
${bundleContent}
  </script>
</body>
</html>`;

  let server: Server;
  let port: number;

  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    });
    server.listen(0, () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 3000;
      resolve();
    });
  });

  try {
    const browserInstance = await playwright[browser].launch({
      headless: !debug,
    });

    const context = await browserInstance.newContext();
    const page = await context.newPage();

    // Capture console output
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        console.error(text);
      } else {
        console.log(text);
      }
    });

    // Capture page errors
    page.on("pageerror", (err) => {
      console.error("Page error:", err.message);
    });

    await page.goto(`http://localhost:${port}/`);

    // Wait for tests to complete
    await page.waitForFunction(
      () => (globalThis as any).__LIBUILD_TEST__?.ended === true,
      { timeout }
    );

    // Get results
    const results = await page.evaluate(() => (globalThis as any).__LIBUILD_TEST__);

    if (!debug) {
      await browserInstance.close();
    } else {
      console.log("\nDebug mode: browser left open. Press Ctrl+C to exit.");
      await new Promise(() => {}); // Wait forever
    }

    return {
      platform: `browser (${browser})`,
      passed: results.passed,
      failed: results.failed,
      errors: results.errors,
    };
  } finally {
    server!.close();
  }
}

/**
 * Print test results summary
 */
function printResults(results: TestResult[]): boolean {
  console.log("\n" + "=".repeat(60));
  console.log("Test Results Summary");
  console.log("=".repeat(60));

  let allPassed = true;

  for (const result of results) {
    const status = result.failed === 0 ? "✓" : "✗";
    const color = result.failed === 0 ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";

    let summaryLine = `${color}${status}${reset} ${result.platform}: ${result.passed} passed, ${result.failed} failed`;
    if (result.todo) summaryLine += `, ${result.todo} todo`;
    if (result.skipped) summaryLine += `, ${result.skipped} skipped`;
    console.log(summaryLine);

    if (result.failed > 0) {
      allPassed = false;
      for (const error of result.errors) {
        console.log(`    ✗ ${error.name}`);
        console.log(`      ${error.error}`);
      }
    }
  }

  console.log("=".repeat(60));

  return allPassed;
}

/**
 * Main test runner
 */
export async function runTests(options: Partial<TestRunnerOptions> = {}): Promise<boolean> {
  const opts: TestRunnerOptions = {
    cwd: options.cwd || process.cwd(),
    patterns: options.patterns || DEFAULT_PATTERNS,
    platforms: options.platforms || ["bun"],
    debug: options.debug || false,
    timeout: options.timeout || 60000,
    watch: options.watch || false,
  };

  console.log("Finding test files...");
  const { testFiles, setupFile } = await collectTests(opts.cwd, opts.patterns);

  if (testFiles.length === 0) {
    console.log("No test files found.");
    return true;
  }

  console.log(`Found ${testFiles.length} test file(s)`);
  if (setupFile) {
    console.log(`Using setup file: ${Path.relative(opts.cwd, setupFile)}`);
  }

  // Create temp directory for bundles
  const tempDir = Path.join(opts.cwd, ".libuild-test");
  await FS.mkdir(tempDir, { recursive: true });

  const results: TestResult[] = [];

  try {
    for (const platform of opts.platforms) {
      console.log(`\nBuilding tests for ${platform}...`);
      const bundlePath = await bundleTests(testFiles, platform, tempDir, opts.cwd);

      console.log(`Running tests on ${platform}...`);

      let result: TestResult;
      if (platform === "bun") {
        result = await runBunTests(bundlePath, opts.timeout);
      } else if (platform === "node") {
        result = await runNodeTests(bundlePath, opts.timeout);
      } else {
        // Browser platforms: chromium, firefox, webkit
        result = await runBrowserTests(bundlePath, platform, opts.timeout, opts.debug, opts.cwd);
      }

      results.push(result);
    }

    return printResults(results);
  } finally {
    // Clean up temp directory (unless in debug mode)
    if (!opts.debug) {
      await FS.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Detect available platforms
 */
export async function detectPlatforms(): Promise<("bun" | "node" | "browser")[]> {
  const platforms: ("bun" | "node" | "browser")[] = [];

  // Check for Bun
  const { spawn } = await import("child_process");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("bun", ["--version"], { stdio: "ignore" });
      child.on("close", (code) => (code === 0 ? resolve() : reject()));
      child.on("error", reject);
    });
    platforms.push("bun");
  } catch {}

  // Node is always available (we're running in it)
  platforms.push("node");

  // Check for Playwright
  try {
    await import("playwright");
    platforms.push("browser");
  } catch {}

  return platforms;
}
