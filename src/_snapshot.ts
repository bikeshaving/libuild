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

// ---------------------------------------------------------------------------
// Registration count. A shard that dies mid-run can only report how many tests
// FINISHED; the total it was going to run is knowable only from inside the
// child, because both runtimes register every top-level test (running the file
// body) before executing any of them. So we count registrations here and print
// the total on stdout, where the parent parses it back out - giving a timeout
// message a denominator ("12 of 47 finished") instead of a bare numerator.
//
// Wire format shared with `_test-runner.ts` (REGISTERED_MARKER there); keep the
// two literals in sync. node's TAP reporter re-emits child stdout as a "# ..."
// comment, so the parser tolerates a leading prefix.
// ---------------------------------------------------------------------------
const REGISTERED_MARKER = "__LIBUILD_REGISTERED__";

let registeredCount = 0;
let emitScheduled = false;

/**
 * Count one registered test and schedule the total to be printed.
 *
 * The emit is deferred to a microtask rather than printed per registration:
 * a module body is one synchronous block, so the microtask drains after the
 * WHOLE file has registered, and one line carries the final total. Re-arming on
 * later registrations covers top-level await (which splits the body into
 * several sync chunks) and tests registered from inside other tests - each
 * emits an updated total, and the parent takes the last one it sees.
 *
 * Browsers have no parent process parsing stdout, so this stays node/bun-only
 * rather than spamming the captured console output.
 */
function noteRegistration(n: number = 1): void {
  registeredCount += n;
  // The `process` guard is defense in depth: today the browser path never
  // reaches this at all (test.ts only calls wrapTestApi on node/bun), but
  // nothing strips the marker from captured browser console output, so if
  // that ever changes this guard is what keeps it user-invisible.
  if (emitScheduled || typeof process === "undefined") return;
  emitScheduled = true;
  queueMicrotask(() => {
    emitScheduled = false;
    console.log(`${REGISTERED_MARKER} ${registeredCount}`);
  });
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

/**
 * Wrap a runner block (`test`/`it`/`describe`) so snapshot keys can track the
 * current test name, WITHOUT depending on the block's object shape. Earlier
 * versions enumerated and copied sub-methods (`.todo`/`.skip`/`.only`/`.each`/
 * ...); that coupled us to how each runtime exposes them and broke twice - bun
 * puts them on the prototype (own-prop copy missed them) and defines some as
 * getters that throw for the wrong block type (`describe.failing` throws, so
 * eagerly reading it crashed module import). A Proxy forwards every access
 * lazily, so anything we don't care about - prototype vs own, throwing getters,
 * sub-methods added in future runtime versions - behaves exactly as native.
 *
 * bun's sub-methods are BRANDED: they're getters on `ScopeFunctions.prototype`
 * that require `this instanceof ScopeFunctions` both when read and when the
 * resolved function is called. So we must (a) resolve each getter against the
 * real `target`, not the proxy `receiver` (else the getter throws), and
 * (b) bind the resolved function to `target` (else calling it - e.g.
 * `test.each(table)` - throws at call time). node's sub-methods are plain data
 * properties, for which both steps are harmless no-ops.
 *
 * We intercept only two things:
 *  - apply: wrap the test body so its name is tracked while it runs.
 *  - get `.only`: its body DOES run, so return a tracking wrapper of it too.
 *    (`.skip`/`.todo` bodies never run; `.each` rows aren't tracked in v1.)
 *
 * `counts` marks the blocks that register a runnable test (`test`/`it`, not
 * `describe`) so the registration total covers tests that were actually going
 * to run - `.skip`/`.todo` reach the runner through the `get` trap, never here.
 */
function wrapBlock(real: any, track: (name: unknown, fn: any) => any, counts = false): any {
  return new Proxy(real, {
    apply(target, thisArg, args) {
      const [name, body, ...rest] = args;
      if (counts) noteRegistration();
      return typeof body === "function"
        ? Reflect.apply(target, thisArg, [name, track(name, body), ...rest])
        : Reflect.apply(target, thisArg, args);
    },
    get(target, prop) {
      // Resolve against target (not the proxy) so bun's branded getters accept
      // `this`; a throwing getter (e.g. describe.failing) still throws only here,
      // when the user actually reads it - exactly as the native block would.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      // Bind so the resolved sub-method sees `this === target` when called.
      const bound = value.bind(target);
      if (prop === "only") {
        // .only runs its body -> track it too.
        return function (name: unknown, body: unknown, ...rest: any[]) {
          if (counts) noteRegistration();
          return typeof body === "function"
            ? bound(name, track(name, body), ...rest)
            : bound(name, body, ...rest);
        };
      }
      // Registration counting for the sub-methods that register runnable or
      // reported tests. skip/todo count because both runtimes REPORT them
      // (node's TAP summary and bun's "N skip"/"N todo" lines), so the "x of
      // y" numerator includes them - an uncounted .skip would push the
      // denominator below the numerator. .each counts one per table row: each
      // row becomes a reported test. Sub-methods we don't know about
      // (runtime-specific variants like skipIf) fall through uncounted; the
      // runner suppresses the denominator when the count is inconsistent, so
      // an exotic path degrades the message rather than corrupting it.
      if (counts && (prop === "skip" || prop === "todo" || prop === "failing")) {
        return function (...args: any[]) {
          noteRegistration();
          return bound(...args);
        };
      }
      if (counts && prop === "each") {
        return function (table: unknown, ...tableRest: any[]) {
          const registrar = bound(table, ...tableRest);
          if (typeof registrar !== "function") return registrar;
          return function (...args: any[]) {
            noteRegistration(Array.isArray(table) ? table.length : 1);
            return registrar(...args);
          };
        };
      }
      return bound;
    },
  });
}

/**
 * Return name-tracking versions of describe/test/it that share state with the
 * snapshot matcher. `@b9g/libuild/test` exports these instead of the raw ones.
 */
export function wrapTestApi<T extends { describe: any; test: any; it: any }>(api: T): T {
  return {
    ...api,
    describe: wrapBlock(api.describe, trackSuite),
    test: wrapBlock(api.test, trackBody, true),
    it: wrapBlock(api.it, trackBody, true),
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
