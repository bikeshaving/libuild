/**
 * @b9g/libuild portable snapshots (internal).
 *
 * `@b9g/libuild/test` hands out `expect` from bun:test on Bun and from the
 * `expect` package on Node. Only bun's has `toMatchSnapshot`, and it uses bun's
 * own format/location - so a snapshot written on one runtime won't verify on the
 * other. This module overrides `toMatchSnapshot` on BOTH with one portable
 * implementation, so the `.snap` files and behavior are identical across bun and
 * node. (Browsers have no filesystem; `_test-browser` provides a throwing stub.)
 *
 * Three things a snapshot matcher needs, and how we get them without a host
 * runner:
 *  - Which file: injected per-shard as `globalThis.__LIBUILD_SNAPSHOT_FILE__`
 *    (each file runs in its own process, so there's exactly one - see
 *    `_test-runner` `generateTestEntry`).
 *  - Which key: we wrap describe/test/it (see `wrapTestApi`) to track the current
 *    jest-style test name; the key is `<name> <n>` with a per-test counter.
 *  - Read/write: sync `node:fs`, loaded dynamically at install time (a static
 *    import of the builtin would crash the browser bundle at load).
 */

// ---------------------------------------------------------------------------
// Runtime deps, loaded dynamically on node/bun only (never on browser).
// Cached so the sync matcher can use them without awaiting.
// ---------------------------------------------------------------------------
type FS = typeof import("fs");
let fs: FS | null = null;
let prettyFormat: ((value: unknown, opts?: Record<string, unknown>) => string) | null = null;

// ---------------------------------------------------------------------------
// Current-test tracking (populated by the wrapped describe/test/it below).
// Tests run sequentially within a file on both runtimes, so a plain stack /
// single "current name" is sufficient (documented constraint).
// ---------------------------------------------------------------------------
const describeStack: string[] = [];
let currentTestName: string | null = null;
// key = test full name (+ optional hint); value = how many snapshots taken so
// far in that test, so repeated toMatchSnapshot() calls get "name 1", "name 2".
const counters = new Map<string, number>();

function fullNameFor(name: unknown): string {
  const prefix = describeStack.join(" > ");
  return prefix ? `${prefix} > ${String(name)}` : String(name);
}

/**
 * Wrap a test body so that, while it runs, `currentTestName` reflects it. The
 * full name is captured HERE (at registration, when the describe stack is
 * populated), not when the body later runs. Handles sync and async bodies.
 */
function trackBody(name: unknown, fn: (...args: any[]) => any): (...args: any[]) => any {
  const fullName = fullNameFor(name);
  return function (this: any, ...args: any[]) {
    const prev = currentTestName;
    currentTestName = fullName;
    let popped = false;
    const restore = () => { if (!popped) { popped = true; currentTestName = prev; } };
    try {
      const r = fn.apply(this, args);
      if (r && typeof r.then === "function") {
        return Promise.resolve(r).finally(restore);
      }
      restore();
      return r;
    } catch (e) {
      restore();
      throw e;
    }
  };
}

/** Wrap a describe body so nested test names carry the describe prefix. */
function trackSuite(name: unknown, fn: (...args: any[]) => any): (...args: any[]) => any {
  return function (this: any, ...args: any[]) {
    describeStack.push(String(name));
    let popped = false;
    const pop = () => { if (!popped) { popped = true; describeStack.pop(); } };
    try {
      const r = fn.apply(this, args);
      if (r && typeof r.then === "function") {
        return Promise.resolve(r).finally(pop);
      }
      pop();
      return r;
    } catch (e) {
      pop();
      throw e;
    }
  };
}

// Property names that aren't real sub-methods and must not be copied.
const FUNCTION_INTERNALS = new Set(["length", "name", "prototype", "arguments", "caller", "constructor"]);

/**
 * Collect sub-method names of a runner block. node's `bun:test`/`node:test`
 * differ here: node exposes `.todo`/`.skip`/`.only`/`.each` as OWN properties,
 * but bun puts them on the PROTOTYPE - so `Object.getOwnPropertyNames(test)`
 * returns just `length,name` on bun and every sub-method is silently dropped
 * (any `test.todo(...)` then throws and aborts the rest of that file). Walk the
 * prototype chain up to (but not including) `Function.prototype` so both are
 * covered without picking up `call`/`apply`/`bind`/`toString`.
 */
function subMethodNames(real: any): string[] {
  const names = new Set<string>();
  let obj = real;
  while (obj && obj !== Function.prototype && obj !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (!FUNCTION_INTERNALS.has(key)) names.add(key);
    }
    obj = Object.getPrototypeOf(obj);
  }
  return [...names];
}

/**
 * Build a name-tracking wrapper around a runner's `test`/`it` (or `describe`),
 * preserving sub-methods like `.only`/`.skip`/`.todo`/`.each`. `.only` bodies
 * DO execute, so they get tracked too; `.skip`/`.todo` bodies never run, and
 * `.each` is passed through (its per-row names aren't tracked in v1).
 */
function wrapBlock(real: any, track: (name: unknown, fn: any) => any): any {
  const call = (fn: any) =>
    function (this: any, name: unknown, body: unknown, ...rest: any[]) {
      return typeof body === "function"
        ? fn.call(this, name, track(name, body), ...rest)
        : fn.call(this, name, body as any, ...rest);
    };

  const wrapped: any = call(real);
  for (const key of subMethodNames(real)) {
    const value = real[key];
    if (key === "only" && typeof value === "function") {
      wrapped[key] = call(value); // .only runs its body -> track it
    } else if (typeof value === "function") {
      wrapped[key] = value.bind(real); // .skip/.todo/.each/... preserved as-is
    } else {
      wrapped[key] = value;
    }
  }
  return wrapped;
}

/**
 * Return name-tracking versions of describe/test/it that share state with the
 * snapshot matcher. `@b9g/libuild/test` exports these instead of the raw ones.
 */
export function wrapTestApi<T extends { describe: any; test: any; it: any }>(api: T): T {
  return {
    ...api,
    describe: wrapBlock(api.describe, trackSuite),
    test: wrapBlock(api.test, trackBody),
    it: wrapBlock(api.it, trackBody),
  };
}

// ---------------------------------------------------------------------------
// .snap file format: jest-compatible module text, but written and parsed by us
// (no eval/require). Values are backtick-escaped and round-trip exactly.
// ---------------------------------------------------------------------------

const SNAP_HEADER = "// Jest Snapshot v1, https://goo.gl/fbAQLP\n";

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** Read a backtick-delimited template starting at `start`, honoring escapes. */
function readTemplate(s: string, start: number): { value: string; end: number } | null {
  let out = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      out += s[i + 1] ?? "";
      i++;
      continue;
    }
    if (c === "`") return { value: out, end: i + 1 };
    out += c;
  }
  return null;
}

export function parseSnapshots(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const OPEN = "exports[`";
  let i = 0;
  while (true) {
    const idx = content.indexOf(OPEN, i);
    if (idx === -1) break;
    const key = readTemplate(content, idx + OPEN.length);
    if (!key) break;
    // Expect the literal separator "`] = `" after the key.
    const sep = "] = `";
    if (content.slice(key.end, key.end + sep.length) !== sep) {
      i = key.end;
      continue;
    }
    const val = readTemplate(content, key.end + sep.length);
    if (!val) break;
    map.set(key.value, val.value);
    i = val.end;
  }
  return map;
}

export function formatSnapshots(map: Map<string, string>): string {
  let out = SNAP_HEADER;
  for (const key of [...map.keys()].sort()) {
    out += `\nexports[\`${escapeTemplate(key)}\`] = \`${escapeTemplate(map.get(key)!)}\`;\n`;
  }
  return out;
}

/** `<dir>/__snapshots__/<basename>.snap` next to the source test file. */
export function snapshotPathFor(file: string): { dir: string; path: string } {
  const norm = file.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const dir = slash === -1 ? "." : norm.slice(0, slash);
  const base = slash === -1 ? norm : norm.slice(slash + 1);
  const snapDir = `${dir}/__snapshots__`;
  return { dir: snapDir, path: `${snapDir}/${base}.snap` };
}

// In-memory cache per .snap path: loaded once, written through on each update.
// Sequential execution within a file makes this race-free.
const loaded = new Map<string, Map<string, string>>();

function getSnapshots(path: string): Map<string, string> {
  let m = loaded.get(path);
  if (!m) {
    m = fs!.existsSync(path) ? parseSnapshots(fs!.readFileSync(path, "utf8")) : new Map();
    loaded.set(path, m);
  }
  return m;
}

function writeSnapshots(dir: string, path: string, map: Map<string, string>): void {
  fs!.mkdirSync(dir, { recursive: true });
  fs!.writeFileSync(path, formatSnapshots(map));
}

// ---------------------------------------------------------------------------
// Serialization: strings verbatim (the common case - rendered output blobs),
// everything else via pretty-format for deterministic, diffable output.
// ---------------------------------------------------------------------------
function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  return prettyFormat!(value, { printBasicPrototype: false, escapeString: false });
}

function indent(s: string): string {
  return s.split("\n").map((l) => "    " + l).join("\n");
}

// ---------------------------------------------------------------------------
// The matcher.
// ---------------------------------------------------------------------------
interface MatcherResult {
  pass: boolean;
  message: () => string;
}

function toMatchSnapshot(this: any, received: unknown, hint?: string): MatcherResult {
  const file = (globalThis as any).__LIBUILD_SNAPSHOT_FILE__;
  if (typeof file !== "string" || !file) {
    throw new Error(
      "toMatchSnapshot() requires the libuild test runner (no snapshot-file context found). " +
      "Run your tests with `libuild test`."
    );
  }
  const update = (globalThis as any).__LIBUILD_UPDATE_SNAPSHOTS__ === true;

  const testName = currentTestName ?? "<unknown>";
  const base = hint ? `${testName}: ${hint}` : testName;
  const n = (counters.get(base) ?? 0) + 1;
  counters.set(base, n);
  const key = `${base} ${n}`;

  const serialized = serialize(received);
  const { dir, path } = snapshotPathFor(file);
  const snapshots = getSnapshots(path);
  const existing = snapshots.get(key);

  // First-ever run for this key, or update mode: (re)write and pass.
  if (existing === undefined || update) {
    snapshots.set(key, serialized);
    writeSnapshots(dir, path, snapshots);
    return { pass: true, message: () => "" };
  }

  const pass = existing === serialized;
  return {
    pass,
    message: () =>
      pass
        ? `Snapshot "${key}" matched`
        : `Snapshot "${key}" does not match:\n\n` +
          `  Stored:\n${indent(existing)}\n\n` +
          `  Received:\n${indent(serialized)}\n\n` +
          `  Run \`libuild test -u\` to update it.`,
  };
}

/**
 * Load the sync deps (node/bun only) and register the portable matcher on the
 * given `expect`. Must be awaited before tests run; `@b9g/libuild/test` does so
 * at module load (top-level await), long before any test body executes.
 */
export async function installSnapshotMatcher(expect: any): Promise<void> {
  const [fsMod, moduleMod] = await Promise.all([
    import("node:fs"),
    import("node:module"),
  ]);
  fs = fsMod as unknown as FS;
  // pretty-format is CJS: bun's dynamic `import()` hands back dead bindings for
  // CJS npm packages, so resolve it through createRequire (works on bun + node).
  const require = (moduleMod as any).createRequire(import.meta.url);
  const pf: any = require("pretty-format");
  prettyFormat = typeof pf === "function" ? pf : pf.format;
  expect.extend({ toMatchSnapshot });
}
