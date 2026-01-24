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
 * Generate entry point that imports all test files
 */
function generateTestEntry(testFiles: string[], platform: string): string {
  const imports = testFiles
    .map((file, i) => `import "${file.replace(/\\/g, "/")}";`)
    .join("\n");

  return `// Auto-generated test entry for ${platform}
${imports}
`;
}

/**
 * Check if platform is a browser
 */
function isBrowserPlatform(platform: Platform): platform is "chromium" | "firefox" | "webkit" {
  return platform === "chromium" || platform === "firefox" || platform === "webkit";
}

/**
 * Bundle tests for a specific platform
 */
async function bundleTests(
  testFiles: string[],
  platform: Platform,
  outDir: string,
  cwd: string
): Promise<string> {
  const entryContent = generateTestEntry(testFiles, platform);
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
    target: isBrowser ? "es2020" : "node18",
    // Replace @b9g/libuild/test with platform-specific shim
    alias: {
      "@b9g/libuild/test": shimPath,
    },
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

/**
 * Parse TAP output to extract test results
 * Node TAP output uses "type: 'test'" for actual tests vs "type: 'suite'" for describe blocks
 */
function parseTapOutput(output: string): { passed: number; failed: number; errors: Array<{ name: string; error: string }> } {
  let passed = 0;
  let failed = 0;
  const errors: Array<{ name: string; error: string }> = [];

  const lines = output.split("\n");
  let lastTestName = "";
  let lastTestPassed = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // TAP format: "ok 1 - test name" or "not ok 1 - test name"
    const okMatch = line.match(/^\s*ok \d+ - (.+)/);
    const notOkMatch = line.match(/^\s*not ok \d+ - (.+)/);

    if (okMatch) {
      lastTestName = okMatch[1];
      lastTestPassed = true;
    } else if (notOkMatch) {
      lastTestName = notOkMatch[1];
      lastTestPassed = false;
    }

    // Check if this is a test (not a suite) by looking for type: 'test'
    if (line.includes("type: 'test'") || line.includes('type: "test"')) {
      if (lastTestPassed) {
        passed++;
      } else {
        failed++;
        errors.push({ name: lastTestName, error: "Test failed" });
      }
    }
  }

  return { passed, failed, errors };
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
            if (pendingTest.passed) {
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

    child.on("close", () => {
      const { passed, failed, errors } = parseTapOutput(stdout);
      resolve({
        platform: "node",
        passed,
        failed,
        errors,
      });
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
function parseBunOutput(output: string): { passed: number; failed: number; errors: Array<{ name: string; error: string }> } {
  let passed = 0;
  let failed = 0;
  const errors: Array<{ name: string; error: string }> = [];

  // Match "N pass" and "N fail" lines
  const passMatch = output.match(/^\s*(\d+)\s+pass/m);
  const failMatch = output.match(/^\s*(\d+)\s+fail/m);

  if (passMatch) passed = parseInt(passMatch[1], 10);
  if (failMatch) failed = parseInt(failMatch[1], 10);

  return { passed, failed, errors };
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

    child.on("close", () => {
      const { passed, failed, errors } = parseBunOutput(stdout + stderr);
      resolve({
        platform: "bun",
        passed,
        failed,
        errors,
      });
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

    console.log(
      `${color}${status}${reset} ${result.platform}: ${result.passed} passed, ${result.failed} failed`
    );

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
  const testFiles = await findTestFiles(opts.cwd, opts.patterns);

  if (testFiles.length === 0) {
    console.log("No test files found.");
    return true;
  }

  console.log(`Found ${testFiles.length} test file(s)`);

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
