/**
 * @b9g/libuild test runner
 *
 * Cross-platform test execution for Bun, Node, and browsers.
 */

import * as FS from "fs/promises";
import * as Path from "path";
import * as OS from "os";
import { createServer, type Server } from "http";
import * as ESBuild from "esbuild";
// All builds go through this wrapper so a dead esbuild service recovers instead
// of cascading into every later build (see _esbuild.ts).
import { build as esbuildBuild } from "./_esbuild.ts";
import { packageTypeRefusalMessage } from "./libuild.ts";
import { createRequire } from "module";

// ---------------------------------------------------------------------------
// Color output. Zero-config, following the de-facto conventions: honor NO_COLOR
// (disable) and FORCE_COLOR (enable), otherwise color only when our stdout is a
// TTY - so an interactive run is colored and a piped/CI run stays clean. When
// color is on we ALSO set FORCE_COLOR on the child runners, so their own output
// (e.g. bun's assertion diffs) stays colored through the pipe we capture it on;
// their summaries are ANSI-stripped before parsing so the codes never corrupt
// the pass/fail counts.
// ---------------------------------------------------------------------------
const USE_COLOR: boolean = (() => {
  const { NO_COLOR, FORCE_COLOR } = process.env;
  if (NO_COLOR) return false;
  if (FORCE_COLOR != null && FORCE_COLOR !== "") return FORCE_COLOR !== "0";
  return Boolean(process.stdout.isTTY);
})();

const paint = (code: string, s: string): string => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const dim = (s: string) => paint("2", s);

// Env for spawned runners: inherit, plus FORCE_COLOR when we've chosen color.
const CHILD_ENV: NodeJS.ProcessEnv | undefined = USE_COLOR
  ? { ...process.env, FORCE_COLOR: "1" }
  : undefined;

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, "");

// ---------------------------------------------------------------------------
// Registration total. `_snapshot.ts` counts the tests a file registers and
// prints this marker on the child's stdout (see its REGISTERED_MARKER); we read
// it back here so a timeout can say "12 of 47 finished" rather than just "12
// finished". Wire format shared across the process boundary - keep in sync.
//
// The child may print several (top-level await, tests registering tests), each
// carrying a running total, so the LAST one is authoritative. node's TAP
// reporter re-emits child stdout as "# ..." comments, hence no anchoring.
// ---------------------------------------------------------------------------
const REGISTERED_MARKER = "__LIBUILD_REGISTERED__";
// Anchored to the whole line (node's TAP reporter re-emits child stdout as a
// "# " comment, hence the optional prefix; trailing \s* tolerates \r). The
// anchoring is load-bearing: an unanchored scan let a test's OWN output - a
// console.log mentioning the marker, a bun code frame quoting the bundle -
// hijack the count, and an `includes`-based strip deleted such lines from the
// failure dump, eating exactly the output that explained the failure.
const REGISTERED_LINE = new RegExp(`^\\s*(?:#\\s*)?${REGISTERED_MARKER}\\s+(\\d+)\\s*$`);

/** Last registration total the child reported, or null if it reported none. */
export function parseRegistered(output: string): number | null {
  let last: number | null = null;
  for (const line of stripAnsi(output).split("\n")) {
    const m = line.match(REGISTERED_LINE);
    if (m) last = parseInt(m[1], 10);
  }
  return last;
}

/** Drop the marker lines so they never surface in a failure dump. */
export function stripRegistered(output: string): string {
  return output
    .split("\n")
    .filter((line) => !REGISTERED_LINE.test(stripAnsi(line)))
    .join("\n");
}

export type Platform = "bun" | "node" | "chromium" | "firefox" | "webkit";

export interface TestRunnerOptions {
  /** Working directory */
  cwd: string;
  /**
   * Glob patterns selecting test files. Defaults to DEFAULT_PATTERNS, EXCEPT
   * when `files` is non-empty and no patterns are given - naming files
   * explicitly means "run exactly these" (issue #19).
   */
  patterns?: string[];
  /** Explicit test files to run, in addition to whatever `patterns` matches */
  files?: string[];
  /** Platforms to run on (bun, node, chromium, firefox, webkit) */
  platforms: Platform[];
  /** Enable debug mode (keeps browser open) */
  debug: boolean;
  /** Per-file test timeout in ms (each file runs in its own process) */
  timeout: number;
  /** Write/overwrite snapshots instead of comparing (toMatchSnapshot) */
  updateSnapshots: boolean;
}

export interface TestResult {
  platform: string;
  passed: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
  skipped?: number;
  todo?: number;
}

// One per-file shard's result plus its captured output (dumped on failure).
interface ShardRun {
  result: TestResult;
  output: string;
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

const TEST_DIR_NAMES = new Set(["test", "tests", "__tests__"]);

/**
 * Default patterns, adjusted for the root they run from. `**\/test/**` means
 * "any file under a directory named test" - but evaluated from INSIDE that
 * directory it demands a nested test/test/, so `libuild test test/` (or
 * running from within test/) discovered nothing unless files carried the
 * `.test.` infix. When the root itself is a test directory, everything under
 * it is a test file, same as the parent-rooted glob would have said.
 */
export function defaultPatternsFor(cwd: string): string[] {
  return TEST_DIR_NAMES.has(Path.basename(cwd).toLowerCase())
    ? [...DEFAULT_PATTERNS, "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
    : DEFAULT_PATTERNS;
}

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
 * Locate the optional setup file: `test-setup.test.{ts,tsx,js,jsx}`. A single
 * global preload imported before all tests on every platform (register
 * beforeEach/afterEach, install polyfills, etc.); switch behavior per-runtime
 * inside it (`if (typeof Bun !== "undefined")`).
 *
 * The `.test.`/`.spec.` infix is deliberate: the file is a `*.test.*`/`*.spec.*`
 * match, so it's discovered by the SAME test globs as everything else - found
 * wherever your tests live, matching whichever suffix convention your suite
 * uses, with no separate discovery mechanism. It is then recognized by name,
 * pulled out of the run (see collectTests), and imported first instead of
 * executed as a test. The `test-` prefix keeps it from colliding with a real
 * test named setup.*. One global setup is the model, so more than one is an
 * error rather than a silent guess.
 */
export function isSetupFile(file: string): boolean {
  return /(?:^|[\\/])test-setup\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(file);
}

/**
 * Discover the test files and the optional setup file, excluding the setup
 * file from the test set (it's caught by the test-directory glob but is a
 * preload, not a test). Exported so discovery/exclusion is testable without
 * spawning.
 *
 * `files` are explicit paths (a single-file run, see issue #19); they're unioned
 * with whatever `patterns` matches. The setup file is always looked up with the
 * FULL default globs rather than `patterns`, so narrowing the selection - to one
 * file, or via --filter - still preloads the same setup the whole-suite run uses.
 * That parity is the point of the single-file loop: same loader, same setup.
 */
export async function collectTests(
  cwd: string,
  patterns: string[],
  files: string[] = []
): Promise<{ testFiles: string[]; setupFile: string | null }> {
  const selected = [
    ...files.map((f) => Path.resolve(cwd, f)),
    ...(patterns.length ? await findTestFiles(cwd, patterns) : []),
  ];

  // The setup file is itself a *.test.* match (see isSetupFile), so it's found
  // by the default globs - recognize it, keep it out of the run, and hand it
  // back to be imported first. One global setup is the model; error on more.
  const setupMatches = (await findTestFiles(cwd, DEFAULT_PATTERNS)).filter(isSetupFile);
  if (setupMatches.length > 1) {
    throw new Error(
      `Multiple test-setup.{test,spec}.* files found; libuild supports one global setup file:\n` +
      setupMatches.map((f) => `  ${Path.relative(cwd, f)}`).join("\n")
    );
  }
  const setupFile = setupMatches[0] ?? null;
  const testFiles = [...new Set(selected)].filter((f) => !isSetupFile(f));

  return { testFiles, setupFile };
}

const GLOB_CHARS = /[*?[\]{}]/;

/**
 * Turn the `test` command's positional arguments into a working directory plus
 * an explicit file list / glob patterns (issue #19).
 *
 * - no targets, or a single directory: discover under that directory (the
 *   original behavior)
 * - one or more existing files: run exactly those, relative to the CURRENT
 *   directory - so setup-file discovery and the printed paths match a full run
 * - an unexpanded glob (quoted, or no shell match): kept as a pattern
 */
export async function resolveTestTargets(
  baseCwd: string,
  targets: string[]
): Promise<{ cwd: string; files: string[]; patterns: string[] }> {
  const empty = { cwd: baseCwd, files: [] as string[], patterns: [] as string[] };
  if (targets.length === 0) return empty;

  const stats = await Promise.all(
    targets.map(async (t) => {
      try {
        return await FS.stat(Path.resolve(baseCwd, t));
      } catch {
        return null;
      }
    })
  );

  // A lone directory argument keeps the original meaning: it IS the root.
  if (targets.length === 1 && stats[0]?.isDirectory()) {
    return { ...empty, cwd: Path.resolve(baseCwd, targets[0]) };
  }

  const files: string[] = [];
  const patterns: string[] = [];
  for (const [i, target] of targets.entries()) {
    const stat = stats[i];
    if (stat?.isFile()) {
      files.push(Path.resolve(baseCwd, target));
    } else if (stat?.isDirectory()) {
      throw new Error(
        `Cannot mix a directory with other test targets: ${target}\n` +
        `Pass a single directory, or a list of test files.`
      );
    } else if (GLOB_CHARS.test(target)) {
      patterns.push(target);
    } else {
      throw new Error(`No such test file or directory: ${target}`);
    }
  }

  return { cwd: baseCwd, files, patterns };
}

/**
 * Generate entry point that imports the setup file (if any) then all test files.
 * Also injects the two snapshot globals the portable toMatchSnapshot reads (see
 * `_snapshot`): the source file identifies the `.snap` file, and the update flag
 * switches compare vs write. Both are read lazily at test-run time, so ESM
 * import hoisting placing them "after" the imports doesn't matter.
 */
function generateTestEntry(
  testFiles: string[],
  platform: string,
  setupFile: string | null,
  updateSnapshots: boolean
): string {
  const toImport = (file: string) => `import "${file.replace(/\\/g, "/")}";`;
  const lines: string[] = [];

  // Per-file isolation means a bun/node shard bundles exactly one source file,
  // so its path is the snapshot-file identity. (Browser bundles many files and
  // its toMatchSnapshot throws, so the file global is only set when unambiguous.)
  if (testFiles.length === 1) {
    lines.push(`globalThis.__LIBUILD_SNAPSHOT_FILE__ = ${JSON.stringify(testFiles[0].replace(/\\/g, "/"))};`);
  }
  lines.push(`globalThis.__LIBUILD_UPDATE_SNAPSHOTS__ = ${updateSnapshots ? "true" : "false"};`);

  if (setupFile) {
    lines.push("// Setup file - runs before all tests");
    lines.push(toImport(setupFile));
  }
  lines.push(...testFiles.map(toImport));

  // The ready flag is the browser runner's start signal. ESM guarantees this
  // statement runs only after EVERY imported module has fully evaluated -
  // including top-level-await continuations, however many macrotasks they
  // span. Scheduler-based starts (queueMicrotask, setTimeout) all lose some
  // race with TLA; this is the only ordering the module system actually
  // promises. Node/bun ignore the flag.
  lines.push("globalThis.__LIBUILD_TEST_READY__ = true;");

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

// Specifiers reachable from `@b9g/libuild/test`'s never-run node/bun branches,
// which browser bundles must not leave as live imports (see the comment at the
// `plugins` option below). Two tiers:
//
// - GLOBAL: node builtins and the runtimes' test modules. These can never
//   meaningfully resolve in a browser bundle from ANY importer, and stubbing
//   them (throw at evaluation, not at bundle time) is what lets consumer code
//   keep runtime-guarded dynamic imports (`if (!isBrowser) await import("fs")`)
//   that never execute in the browser.
// - SCOPED to libuild's own modules: real npm packages a consumer's browser
//   test may legitimately import for itself. Only libuild's internal imports
//   are stubbed; a consumer's own `import {format} from "pretty-format"`
//   resolves normally (bundling the real package, or failing with esbuild's
//   ordinary resolution error - either way, correctly attributed).
const GLOBAL_BROWSER_STUBS = ["bun:test", "node:test", "fs", "node:fs", "module", "node:module", "async_hooks", "node:async_hooks"];
const SCOPED_BROWSER_STUBS = ["expect", "pretty-format"];

/**
 * `libuildDir` is the real (symlink-resolved) directory of the consumer's
 * `@b9g/libuild/test` module - matching esbuild's importer paths, which are
 * also realpaths, so scoping survives linked/vendored installs. When it can't
 * be resolved (a bundle graph that never imports the dispatcher), scoped stubs
 * fall back to global, preserving the old behavior for graphs that can't
 * contain consumer imports of these packages anyway.
 */
function makeBrowserStubPlugin(libuildDir: string | null): ESBuild.Plugin {
  const scoped = new Set(SCOPED_BROWSER_STUBS);
  const all = [...GLOBAL_BROWSER_STUBS, ...SCOPED_BROWSER_STUBS];
  const filter = new RegExp(`^(${all.map((s) => s.replace(/[:.-]/g, "\\$&")).join("|")})$`);

  return {
    name: "libuild-browser-stubs",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        if (scoped.has(args.path) && libuildDir != null && !args.importer.startsWith(libuildDir)) {
          return undefined; // consumer's own import - resolve normally
        }
        return { path: args.path, namespace: "libuild-browser-stub" };
      });
      build.onLoad({ filter: /.*/, namespace: "libuild-browser-stub" }, (args) => ({
        // A throwing module BODY (not throwing exports): anything importing
        // this statically links fine at bundle time, and the throw only fires
        // if the module is initialized at runtime - which only a bug can cause.
        contents: `throw new Error(${JSON.stringify(
          `libuild: "${args.path}" is not available in the browser test bundle`
        )});`,
        loader: "js",
      }));
    },
  };
}

/**
 * libuild's ESM-only policy, applied to the test runner: a package that
 * explicitly declares `"type": "commonjs"` is refused for the WHOLE run, on
 * every platform (issue #21; the policy statement and rationale live with
 * `packageTypeRefusalMessage` in libuild.ts, and `build` enforces the same).
 *
 * Returns the refusal message, or null. Exported for direct unit testing.
 */
export async function packageTypeRefusal(cwd: string): Promise<string | null> {
  // Walk UP to the nearest package.json, exactly as node and esbuild resolve
  // the governing manifest - `libuild test test/` roots discovery inside a
  // subdirectory, but the declaration that poisons classification lives at
  // the package root above it.
  for (let dir = Path.resolve(cwd); ; dir = Path.dirname(dir)) {
    try {
      const packageType = JSON.parse(await FS.readFile(Path.join(dir, "package.json"), "utf-8")).type;
      return packageType === "commonjs" ? packageTypeRefusalMessage() : null;
    } catch {
      // keep walking
    }
    if (dir === Path.dirname(dir)) return null; // filesystem root, nothing declared
  }
}

/** Where the consumer's `@b9g/libuild` build actually lives (realpath), for
 * stub scoping. Resolved via the `./package.json` export because it carries no
 * conditions - `./test` is import-only, which a require-based resolve can't
 * see. Node's resolver follows symlinks like esbuild does, so the two agree on
 * linked installs. Null when unresolvable. */
function resolveLibuildDir(cwd: string): string | null {
  try {
    const req = createRequire(Path.join(cwd, "package.json"));
    return Path.dirname(req.resolve("@b9g/libuild/package.json"));
  } catch {
    return null;
  }
}

// Loader by extension, for plugins that read source files themselves.
function loaderFor(path: string): ESBuild.Loader {
  const ext = Path.extname(path).toLowerCase();
  return ext === ".ts" || ext === ".mts" ? "ts"
    : ext === ".tsx" ? "tsx"
    : ext === ".jsx" ? "jsx"
    : "js";
}

/**
 * Keep `import.meta.url` / `.dirname` / `.filename` pointing at each SOURCE
 * file instead of the bundle. Bundling collapses every module's location to
 * `.libuild-test/bundle-*.js`, which silently breaks the
 * fixtures-next-to-the-test pattern (`new URL("./fixtures/x.json",
 * import.meta.url)`, `import.meta.dirname`) with failures that read as bugs
 * in the code under test - fold lost 3 of 20 files to this and the symptoms
 * looked like formatter defects.
 *
 * esbuild has no per-file define, so the standard sidestep: `define` maps the
 * three member expressions to bare identifiers, and this plugin prepends a
 * one-line `var` declaration binding them to the source file's real location
 * in every in-bundle file that mentions `import.meta`. One line, appended
 * BEFORE the original first line without a newline, so line numbers in stack
 * traces don't shift. esbuild renames the vars per module, so each file keeps
 * its own values. Only `import.meta` files pay; everything else loads
 * natively. (`import.meta` used bare, or other properties, still see the
 * bundle - only the three path-shaped members are redirected.)
 */
const IMPORT_META_DEFINE = {
  "import.meta.url": "__libuild_import_meta_url",
  "import.meta.dirname": "__libuild_import_meta_dirname",
  "import.meta.filename": "__libuild_import_meta_filename",
};

function makeImportMetaPlugin(): ESBuild.Plugin {
  return {
    name: "libuild-import-meta",
    setup(build) {
      build.onLoad({ filter: /\.(ts|tsx|mts|js|jsx|mjs)$/ }, async (args) => {
        // node_modules is external on node/bun, so this only ever sees the
        // consumer's own files plus the generated entry.
        const contents = await FS.readFile(args.path, "utf-8");
        if (!contents.includes("import.meta")) return undefined; // load natively
        const url = new URL(`file://${args.path.replace(/\\/g, "/")}`).href;
        const prefix =
          `var __libuild_import_meta_url = ${JSON.stringify(url)}, ` +
          `__libuild_import_meta_dirname = ${JSON.stringify(Path.dirname(args.path))}, ` +
          `__libuild_import_meta_filename = ${JSON.stringify(args.path)}; `;
        return {
          contents: prefix + contents,
          loader: loaderFor(args.path),
          resolveDir: Path.dirname(args.path),
        };
      });
    },
  };
}

/**
 * Bundle tests for a specific platform.
 * Exported for tests that assert externalization behavior.
 */
export async function bundleTests(
  testFiles: string[],
  platform: Platform,
  outDir: string,
  cwd: string,
  id: string = "",
  setupFile: string | null = null,
  updateSnapshots: boolean = false
): Promise<string> {
  const entryContent = generateTestEntry(testFiles, platform, setupFile, updateSnapshots);
  // A per-shard id keeps concurrent per-file bundles from clobbering each other.
  const suffix = id ? `-${id}` : "";
  const entryPath = Path.join(outDir, `entry-${platform}${suffix}.ts`);
  const isBrowser = isBrowserPlatform(platform);
  const outPath = Path.join(outDir, `bundle-${platform}${suffix}.js`);

  // The temp dir declares itself an ES module package. This is what makes the
  // `.js` bundles load as ESM under node in consumers WITHOUT a
  // `"type": "module"` of their own, and what keeps the generated entry
  // classified as ESM by esbuild. libuild is ESM-only, so this is stated once
  // here rather than encoded per-file with .mjs extensions. "wx" so a caller
  // pointing outDir at a real project directory never clobbers its manifest.
  await FS.writeFile(Path.join(outDir, "package.json"), '{"type":"module"}\n', { flag: "wx" })
    .catch(() => {});

  await FS.writeFile(entryPath, entryContent);

  // For Node/Bun, inject a require shim for CJS interop of external deps.
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
    // es2022, not es2020: the `@b9g/libuild/test` dispatcher selects its backend
    // with top-level await, which es2020 can't emit (esbuild errors). TLA in ES
    // modules is supported by every browser Playwright drives.
    target: isBrowser ? "es2022" : "node20",
    // `@b9g/libuild/test` is the single platform-aware entry; it resolves
    // normally (no aliasing) and picks its backend at runtime. On node/bun it
    // stays external (packages: "external") and resolves from the consumer's
    // node_modules. Externalizing node_modules is also how the *built* package
    // runs and avoids bundling bundle-hostile deps like jsdom. On browser the
    // dispatcher is bundled, and its never-run node/bun branches reference
    // `bun:test`/`node:test`/`expect` and the snapshot chunk's `node:fs`/
    // `pretty-format`. Those used to be marked `external` - which left them as
    // LIVE dynamic imports, forcing esbuild to give the dispatcher a lazy async
    // wrapper; importers then needed `await init_test()` at their own top
    // level, and (depending on the esbuild version's wrapper choice) that
    // `await` could land inside a non-async wrapper, making the whole bundle a
    // syntax error before a single test ran. Stubbing resolves them INSIDE the
    // bundle instead: the dispatcher stays plain ESM with its top-level await
    // at genuine top level. The stubs throw if ever actually evaluated - which
    // the browser branch never does.
    ...(isBrowser
      ? { plugins: [makeBrowserStubPlugin(resolveLibuildDir(cwd))] }
      : { packages: "external" as const, plugins: [makeImportMetaPlugin()] }),
    // Inject require shim for node/bun to handle CJS deps like expect/chalk
    ...(isBrowser ? {} : { banner: { js: requireShim } }),
    // Define for dead code elimination; on node/bun also redirect the three
    // path-shaped import.meta members to per-file bindings (see
    // makeImportMetaPlugin). Browser bundles keep the bundle-relative
    // meaning - there is no source filesystem in a page.
    define: {
      "process.env.NODE_ENV": '"test"',
      ...(isBrowser ? {} : IMPORT_META_DEFINE),
    },
    logLevel: "warning",
  };

  await esbuildBuild(buildOptions);

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
export function parseTapOutput(output: string, syntheticName?: string): { passed: number; failed: number; errors: Array<{ name: string; error: string }>; skipped: number; todo: number; completed: boolean } {
  output = stripAnsi(output); // forced color must not corrupt the TAP tokens
  const errors: Array<{ name: string; error: string }> = [];

  let tallyPassed = 0;
  let tallyFailed = 0;
  let tallySkipped = 0;
  let tallyTodo = 0;
  // Suites that failed of their OWN error - a throw in a describe() callback
  // body during registration. Node reports these as `not ok` with
  // `failureType: 'testCodeFailure'`, but counts them under `# suites`, NOT
  // `# fail`, and still exits 0 - so a runner trusting the summary (or the
  // exit code) reports green while every test registered after the throw
  // silently never runs (issue #23). Suites that are `not ok` merely because
  // a CHILD failed carry `failureType: 'subtestsFailed'` and must NOT count,
  // or every ordinary failure would be double-counted through its parents.
  let suiteFailed = 0;

  // Per-entry state machine: each `ok`/`not ok` line opens an entry, its YAML
  // block (type / failureType / error) accumulates onto it, and the next
  // entry (or EOF) finalizes it. The tally can't happen at the `type:` line
  // as it used to - `failureType` and `error` come after it in the block.
  let current: { name: string; notOk: boolean; type?: string; failureType?: string; error?: string } | null = null;

  // When a file registers NO tests, node fabricates one passing test entry
  // named with the file's path and reports "# pass 1" - so a shared helper
  // picked up by the test glob shows as "1 passed" (fold's tests/helpers.js).
  // Files with real tests never get the synthetic entry (or every file would
  // inflate its count by one). The caller passes the bundle's basename;
  // a passing test whose name ends with it is the fabrication, not a test.
  let syntheticSeen = 0;

  const finalize = () => {
    if (!current) return;
    if (current.type === "test") {
      if (syntheticName && !current.notOk && current.name.endsWith(syntheticName)) {
        syntheticSeen++;
        current = null;
        return;
      }
      const directive = current.name.match(TAP_DIRECTIVE);
      const kind = directive ? directive[1].toUpperCase() : null;
      if (kind === "SKIP") {
        tallySkipped++;
      } else if (kind === "TODO") {
        tallyTodo++;
      } else if (current.notOk) {
        tallyFailed++;
        errors.push({ name: current.name, error: current.error ?? "Test failed" });
      } else {
        tallyPassed++;
      }
    } else if (current.type === "suite" && current.notOk && current.failureType !== "subtestsFailed") {
      suiteFailed++;
      errors.push({
        name: `suite "${current.name}" threw during registration`,
        error: (current.error ?? "error during suite registration") +
          " - tests declared after the throw never registered",
      });
    }
    current = null;
  };

  for (const line of output.split("\n")) {
    // TAP format: "ok 1 - test name" or "not ok 1 - test name"
    const okMatch = line.match(/^\s*ok \d+ - (.+)/);
    const notOkMatch = line.match(/^\s*not ok \d+ - (.+)/);
    if (okMatch || notOkMatch) {
      finalize();
      current = { name: (okMatch ?? notOkMatch)![1], notOk: notOkMatch != null };
      continue;
    }
    if (!current) continue;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*type: ['"]?(\w+)/))) {
      current.type = m[1];
    } else if ((m = line.match(/^\s*failureType: ['"]?(\w+)/))) {
      current.failureType = m[1];
    } else if ((m = line.match(/^\s*error: '(.*)'\s*$/))) {
      current.error = m[1];
    }
  }
  finalize();

  // Node's TAP reporter emits an authoritative summary; trust it for the counts
  // when present (the hand tally above still supplies failing-test names).
  // Registration-failed suites are ADDED on top: node's `# fail` deliberately
  // excludes them (they count under `# suites`), which is exactly the blind
  // spot being closed.
  const summary = (label: string): number | null => {
    const m = output.match(new RegExp(`^#\\s*${label}\\s+(\\d+)`, "m"));
    return m ? parseInt(m[1], 10) : null;
  };

  // "completed" means the child actually ran to a result summary. A run that
  // was killed or crashed before finishing produces neither a `# tests` line
  // nor any `type: 'test'` line - it must not be mistaken for a clean 0/0 pass.
  const completed = summary("tests") !== null
    || (tallyPassed + tallyFailed + tallySkipped + tallyTodo + suiteFailed) > 0;

  return {
    // The synthetic file-entry (if seen) is inside node's own "# pass" count
    // too, so it is subtracted from the summary path as well as the tally.
    passed: Math.max(0, (summary("pass") ?? tallyPassed + syntheticSeen) - syntheticSeen),
    failed: (summary("fail") ?? tallyFailed) + suiteFailed,
    skipped: summary("skipped") ?? tallySkipped,
    todo: summary("todo") ?? tallyTodo,
    errors,
    completed,
  };
}

// How long a timed-out child gets to die politely before we SIGKILL it.
const KILL_GRACE_MS = 5000;

interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** We killed it for exceeding the per-file timeout (authoritative, not inferred) */
  timedOut: boolean;
  /** The process could not be spawned at all */
  error: Error | null;
}

/**
 * Spawn one test shard and capture its output.
 *
 * The timeout is enforced here rather than via spawn's own `timeout` option so
 * that "we killed this for running too long" is a fact we RECORD instead of one
 * we try to reconstruct from the exit status afterwards. Reconstruction is
 * exactly what failed in issue #18: node traps our SIGTERM and exits (1, null),
 * which is indistinguishable from an ordinary failing run by exit status alone.
 */
async function spawnShard(command: string, args: string[], timeout: number): Promise<SpawnResult> {
  const { spawn } = await import("child_process");

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: CHILD_ENV,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // Capture only - the per-file orchestrator prints a grouped line and dumps
    // this output on failure (streaming live would interleave across shards).
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    let graceTimer: NodeJS.Timeout | undefined;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // A wedged runner (or one trapping SIGTERM) must not hang the suite.
      graceTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeout);

    const done = (result: Omit<SpawnResult, "stdout" | "stderr" | "timedOut">) => {
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ stdout, stderr, timedOut, ...result });
    };

    child.on("close", (code, signal) => done({ code, signal, error: null }));
    child.on("error", (error) => done({ code: null, signal: null, error }));
  });
}

/**
 * Decide whether a finished shard counts as a successful run, and if not, why.
 * Returns null when the run is trustworthy, otherwise a human-readable reason.
 *
 * A shard is only green when it ran to a result summary, wasn't killed, AND
 * exited cleanly. That last clause is issue #18: on timeout node prints the TAP
 * lines for the tests it managed to finish, then exits (1, null). The old check
 * looked only at "did we see test lines" and "was there a signal", so a timeout
 * read as a clean partial pass - the file's remaining tests silently evaporated
 * from the totals and the suite stayed green.
 */
export function shardFailure(run: {
  completed: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  failed: number;
  timeout: number;
  /** Tests that produced a result before the process died */
  finished: number;
  /** Tests the file registered, when the child got far enough to report it */
  registered?: number | null;
}): string | null {
  // A child that finished cleanly inside the kill-grace window is NOT a
  // timeout failure: the timer fires unconditionally, but if the run produced
  // a complete summary and exited 0 before dying, nothing was lost. Without
  // this, a file finishing at the buzzer reports the nonsense "N of N
  // test(s) finished, the rest never ran".
  const finishedCleanly = run.completed && run.signal == null && run.code === 0;
  if (run.timedOut && !finishedCleanly) {
    // The denominator is what turns "some tests were lost" into "how many".
    // Suppress it when it's inconsistent (finished > registered): the count
    // misses registration paths we don't wrap, and a denominator smaller
    // than the numerator is worse than none.
    const of = run.registered != null && run.registered >= run.finished
      ? `${run.finished} of ${run.registered}`
      : `${run.finished}`;
    return `timed out after ${run.timeout}ms - ${of} test(s) finished, the rest never ran ` +
      `(raise --timeout, or split the file)`;
  }
  if (run.signal != null) return `killed by ${run.signal} (out of memory?)`;
  if (!run.completed) return `exited ${run.code ?? "?"} without producing a test summary`;
  // Completed, but the runner still reported failure while naming no failing
  // test: the file aborted somewhere we can't see (unhandled rejection, a
  // runner-level error). Tests went missing, so this is red, not green.
  if (run.code !== 0 && run.failed === 0) {
    return `exited ${run.code} but reported no failing tests - tests may not have run`;
  }
  return null;
}

/**
 * Run tests in Node.js using node:test
 */
async function runNodeTests(bundlePath: string, timeout: number): Promise<ShardRun> {
  const { stdout, stderr, code, signal, timedOut, error } =
    await spawnShard("node", ["--test", "--test-reporter=tap", bundlePath], timeout);

  if (error) {
    return {
      result: { platform: "node", passed: 0, failed: 1, errors: [{ name: "spawn error", error: error.message }], skipped: 0, todo: 0 },
      output: error.message,
    };
  }

  const { passed, failed, errors, skipped, todo, completed } = parseTapOutput(stdout, Path.basename(bundlePath));
  const reason = shardFailure({
    completed, code, signal, timedOut, failed, timeout,
    finished: passed + failed + skipped + todo,
    registered: parseRegistered(stdout),
  });

  return {
    result: {
      platform: "node",
      passed,
      failed: reason ? Math.max(failed, 1) : failed,
      errors: reason ? [...errors, { name: "node test process did not complete", error: reason }] : errors,
      skipped,
      todo,
    },
    output: stripRegistered(stdout + stderr),
  };
}

/**
 * Parse Bun test output to extract test results
 * Format: "N pass", "N fail"
 */
export function parseBunOutput(output: string): { passed: number; failed: number; errors: Array<{ name: string; error: string }>; skipped: number; todo: number; completed: boolean } {
  output = stripAnsi(output); // forced color must not corrupt the summary tokens
  const errors: Array<{ name: string; error: string }> = [];

  // Match "N pass" / "N fail" / "N skip" / "N todo" summary lines. skip/todo
  // matter beyond display: the registration count (see parseRegistered)
  // includes .skip/.todo registrations, so the "x of y" numerator must too,
  // or a skip-heavy file reads as having lost tests it never intended to run.
  const count = (label: string): number | null => {
    const m = output.match(new RegExp(`^\\s*(\\d+)\\s+${label}`, "m"));
    return m ? parseInt(m[1], 10) : null;
  };
  const passMatch = count("pass");
  const failMatch = count("fail");

  // Bun always prints a "N pass"/"N fail" summary on a completed run; its
  // absence means the child was killed or crashed before finishing.
  const completed = passMatch !== null || failMatch !== null;

  return {
    passed: passMatch ?? 0,
    failed: failMatch ?? 0,
    skipped: count("skip") ?? 0,
    todo: count("todo") ?? 0,
    errors,
    completed,
  };
}

/**
 * Run tests in Bun
 */
async function runBunTests(bundlePath: string, timeout: number): Promise<ShardRun> {
  const { stdout, stderr, code, signal, timedOut, error } =
    await spawnShard("bun", ["test", bundlePath], timeout);

  if (error) {
    return {
      result: { platform: "bun", passed: 0, failed: 1, errors: [{ name: "spawn error", error: error.message }] },
      output: error.message,
    };
  }

  const output = stdout + stderr;
  const { passed, failed, errors, skipped, todo, completed } = parseBunOutput(output);
  const reason = shardFailure({
    completed, code, signal, timedOut, failed, timeout,
    finished: passed + failed + skipped + todo,
    registered: parseRegistered(output),
  });

  return {
    result: {
      platform: "bun",
      passed,
      failed: reason ? Math.max(failed, 1) : failed,
      errors: reason ? [...errors, { name: "bun test process did not complete", error: reason }] : errors,
      skipped,
      todo,
    },
    output: stripRegistered(output),
  };
}

/**
 * Run every test file in its OWN process (per-file isolation is the default),
 * with bounded concurrency, and aggregate the shard results. Isolation frees
 * each file's native/off-heap memory at process exit - which bun/JSC never
 * returns within a single long-lived process, so a large jsdom-backed suite
 * would otherwise thrash and never finish - and lets independent files run in
 * parallel. A killed/crashed/timed-out shard counts as a failure (see shardFailure).
 */
async function runShardedPlatform(
  platform: Platform,
  files: string[],
  tempDir: string,
  cwd: string,
  timeout: number,
  setupFile: string | null,
  updateSnapshots: boolean
): Promise<TestResult> {
  const runShard = platform === "bun" ? runBunTests : runNodeTests;
  const concurrency = Math.max(1, Math.min((OS.cpus().length || 2) - 1, files.length));

  const agg: TestResult = { platform, passed: 0, failed: 0, errors: [], skipped: 0, todo: 0 };
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      const rel = Path.relative(cwd, file);

      let shard: ShardRun;
      try {
        const bundle = await bundleTests([file], platform, tempDir, cwd, String(i), setupFile, updateSnapshots);
        shard = await runShard(bundle, timeout);
      } catch (error: any) {
        shard = {
          result: { platform, passed: 0, failed: 1, errors: [{ name: rel, error: error?.message ?? String(error) }], skipped: 0, todo: 0 },
          output: "",
        };
      }

      const r = shard.result;
      const failed = r.failed > 0;
      // Build the whole per-file report as one string so concurrent shards
      // don't interleave (a single console.log call is atomic).
      let line = `${failed ? red("✗") : green("✓")} ${rel}: ${green(`${r.passed} passed`)}, ${failed ? red(`${r.failed} failed`) : "0 failed"}`;
      if (r.todo) line += `, ${yellow(`${r.todo} todo`)}`;
      if (r.skipped) line += `, ${dim(`${r.skipped} skipped`)}`;
      if (failed && shard.output.trim()) line += "\n" + shard.output.trimEnd();
      console.log(line);

      agg.passed += r.passed;
      agg.failed += r.failed;
      agg.skipped = (agg.skipped ?? 0) + (r.skipped ?? 0);
      agg.todo = (agg.todo ?? 0) + (r.todo ?? 0);
      for (const e of r.errors) agg.errors.push({ name: `${rel} > ${e.name}`, error: e.error });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return agg;
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

  const platformName = `browser (${browser})`;
  let browserInstance: import("playwright").Browser | undefined;
  // Uncaught page errors are the ground truth for "the bundle broke": a test
  // file that throws during load produces one here and may register nothing
  // (or only its predecessors). They must reach the RESULT, not just the log.
  const pageErrors: string[] = [];

  try {
    browserInstance = await playwright[browser].launch({
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
      pageErrors.push(err.message);
      console.error("Page error:", err.message);
    });

    await page.goto(`http://localhost:${port}/`);

    // Wait for the run to END, with a STALL timeout rather than a total
    // budget. `timeout` means "per file" on node/bun, but the browser runs
    // the whole suite as one bundle - a single absolute deadline meant a
    // 30-file suite had to finish everything (browser launch included) in
    // one file's allowance, so big suites "timed out" at the default while
    // making steady progress (crank's 602 tests on firefox). Progress -
    // the ready flag, the runner starting, each completed test - resets the
    // clock; `timeout` ms with NO progress is a genuine hang.
    let stalled: string | null = null;
    {
      let lastProgress = "";
      let stallAt = Date.now() + timeout;
      while (true) {
        const state = await page
          .evaluate(() => {
            const t = (globalThis as any).__LIBUILD_TEST__;
            return {
              loaded: t != null,
              ready: (globalThis as any).__LIBUILD_TEST_READY__ === true,
              started: t?.started === true,
              ended: t?.ended === true,
              done: t ? t.passed + t.failed + (t.skipped ?? 0) : 0,
              loadErrors: t ? t.loadErrors.length : 0,
            };
          })
          .catch(() => null); // navigation/crash mid-poll: treated as no progress
        if (state?.ended) break;
        // A load error before the ready flag is unrecoverable - a module body
        // threw, so the entry (and the runner) can never start. Fail NOW with
        // the error, not after a full stall timeout of silence.
        if (state && !state.ready && state.loadErrors > 0) {
          stalled = "a test file threw while loading - the runner can never start";
          break;
        }
        const progress = JSON.stringify(state);
        if (state && progress !== lastProgress) {
          lastProgress = progress;
          stallAt = Date.now() + timeout;
        }
        if (Date.now() > stallAt) {
          stalled = !state?.loaded
            ? "the bundle never evaluated (crashed at load?)"
            : !state.started
              ? "the runner never started - a test file's top-level await may be hung"
              : `stalled after ${state.done} test(s) completed`;
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (stalled) {
      // Best effort: the page-side capture usually has the precise error even
      // when Playwright's pageerror missed or mangled it.
      const inPage: string[] = await page
        .evaluate(() => (globalThis as any).__LIBUILD_TEST__?.loadErrors ?? [])
        .catch(() => []);
      const detail = [...new Set([...inPage, ...pageErrors])];
      return {
        platform: platformName,
        passed: 0,
        failed: 1,
        errors: [{
          name: "test run never completed",
          error: `${stalled}` +
            (detail.length
              ? `\nerror(s):\n${detail.map((e) => `  ${e}`).join("\n")}`
              : ` (no progress for ${timeout}ms)`),
        }],
      };
    }

    // Get results
    const results = await page.evaluate(() => (globalThis as any).__LIBUILD_TEST__);

    if (debug) {
      console.log("\nDebug mode: browser left open. Press Ctrl+C to exit.");
      await new Promise(() => {}); // Wait forever
    }

    const errors: Array<{ name: string; error: string }> = [...results.errors];
    let failed = results.failed;

    // Phase-aware uncaught errors, recorded IN the page (see noteUncaught in
    // _test-browser.ts). Before the runner started: a test file's body
    // aborted mid-registration, everything after it silently never
    // registered - fail. During the run: registration was already complete
    // (the runner starts on the entry's ready flag), so nothing was lost -
    // surface as warnings. Suites that deliberately float unhandled
    // rejections (error-propagation tests) stay green, and behavior no
    // longer depends on which browser routes rejections to `pageerror`.
    for (const e of results.loadErrors ?? []) {
      failed++;
      errors.push({
        name: "uncaught error during load",
        error: `${e} - tests registered after this error never ran`,
      });
    }
    for (const e of results.runtimeErrors ?? []) {
      console.warn(yellow(`⚠ uncaught during run (not a failure): ${e}`));
    }

    // Zero tests out of discovered test files fails: the registration-loss
    // class of bug (see the ready-flag comment in _test-browser.ts) produced
    // exactly this shape - files found, nothing registered, exit 0 - which
    // would merge as "suite silently disabled, CI green". A run that was
    // going to be empty never gets here (runTests returns early when no
    // files are found). All-skipped files land in `skipped`, not here.
    if (results.passed + failed + (results.skipped ?? 0) === 0) {
      failed = 1;
      errors.push({
        name: "no tests ran",
        error: "test files were bundled and loaded, but zero tests registered - " +
          "usually a file that crashed during load (see page errors above) or " +
          "registered its tests too late",
      });
    }

    return {
      platform: platformName,
      passed: results.passed,
      failed,
      errors,
      skipped: results.skipped,
    };
  } finally {
    server!.close();
    if (browserInstance && !debug) {
      await browserInstance.close().catch(() => {});
    }
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
    const ok = result.failed === 0;
    const status = ok ? green("✓") : red("✗");

    let summaryLine = `${status} ${result.platform}: ${green(`${result.passed} passed`)}, ${ok ? "0 failed" : red(`${result.failed} failed`)}`;
    if (result.todo) summaryLine += `, ${yellow(`${result.todo} todo`)}`;
    if (result.skipped) summaryLine += `, ${dim(`${result.skipped} skipped`)}`;
    console.log(summaryLine);

    if (result.failed > 0) {
      allPassed = false;
      for (const error of result.errors) {
        console.log(`    ${red("✗")} ${error.name}`);
        console.log(`      ${dim(error.error)}`);
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
  const files = options.files ?? [];
  const opts: Required<TestRunnerOptions> = {
    cwd: options.cwd || process.cwd(),
    // Naming files explicitly means "run exactly these" - don't also glob the
    // tree back in (issue #19).
    patterns: options.patterns ?? (files.length ? [] : defaultPatternsFor(options.cwd || process.cwd())),
    files,
    platforms: options.platforms || ["bun"],
    debug: options.debug || false,
    timeout: options.timeout || 60000,
    updateSnapshots: options.updateSnapshots || false,
  };

  // ESM-only, enforced for the whole run: a "type": "commonjs" package is
  // refused on every platform, not just where it happens to break.
  const refusal = await packageTypeRefusal(opts.cwd);
  if (refusal) {
    console.error(red(`libuild test: ${refusal}`));
    return false;
  }

  console.log("Finding test files...");
  const { testFiles, setupFile } = await collectTests(opts.cwd, opts.patterns, opts.files);

  if (testFiles.length === 0) {
    // An explicit selection that matches nothing is a mistake worth failing on:
    // silently "passing" is how a typo'd path or stale --filter becomes a green
    // run. Plain discovery finding nothing stays a no-op success.
    const explicit = opts.files.length > 0 || options.patterns != null;
    console.log(explicit ? red("No test files matched the given files/patterns.") : "No test files found.");
    return !explicit;
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
      let result: TestResult;
      if (platform === "bun" || platform === "node") {
        // Per-file process isolation is the default: each file runs in its own
        // process (frees native memory between files, runs them in parallel).
        console.log(`\nRunning ${testFiles.length} file(s) on ${platform} (per-file isolation)...`);
        result = await runShardedPlatform(platform, testFiles, tempDir, opts.cwd, opts.timeout, setupFile, opts.updateSnapshots);
      } else {
        // Browser runs the combined bundle in a Playwright page (its own
        // isolation model - a separate browser process).
        console.log(`\nBuilding tests for ${platform}...`);
        const bundlePath = await bundleTests(testFiles, platform, tempDir, opts.cwd, "", setupFile, opts.updateSnapshots);
        console.log(`Running tests on ${platform}...`);
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
