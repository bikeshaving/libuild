/**
 * @b9g/libuild portable snapshots (internal).
 *
 * `@b9g/libuild/test` hands out `expect` from bun:test on Bun and from the
 * `expect` package on Node. Only bun's has `toMatchSnapshot`, and it uses bun's
 * own format/location - so a snapshot written on one runtime won't verify on the
 * other. This module overrides `toMatchSnapshot` on BOTH with one portable
 * implementation, so the `.snap` files and behavior are identical across bun and
 * node. (Browsers have no filesystem; `internal/test-browser` provides a throwing stub.)
 *
 * Three things a snapshot matcher needs, and how we get them without a host
 * runner:
 *  - Which file: injected per-shard as `globalThis.__LIBUILD_SNAPSHOT_FILE__`
 *    (each file runs in its own process, so there's exactly one - see
 *    `internal/test-runner` `generateTestEntry`).
 *  - Which key: we wrap describe/test/it (see `wrapTestApi`) to track the current
 *    jest-style test name; the key is `<name> <n>` with a per-test counter.
 *  - Read/write: sync `node:fs`, loaded dynamically at install time (a static
 *    import of the builtin would crash the browser bundle at load).
 */

// The one static import this module allows itself: the AsyncContext shim,
// needed at module init for the current-test variable. Browser bundles link
// it against the node:async_hooks stub and never initialize this chunk.
import {AsyncVariable} from "@b9g/async-context";

// ---------------------------------------------------------------------------
// Runtime deps, loaded dynamically on node/bun only (never on browser).
// Cached so the sync matcher can use them without awaiting.
// ---------------------------------------------------------------------------
type FS = typeof import("fs");
let fs: FS | null = null;
let prettyFormat: ((value: unknown, opts?: Record<string, unknown>) => string) | null = null;

// ---------------------------------------------------------------------------
// Current-test tracking (populated by the wrapped describe/test/it below).
//
// The DESCRIBE prefix is a plain array, deliberately - NOT an AsyncVariable.
// Registering a bun:test test from inside an AsyncLocalStorage scope makes
// bun hang waiting for a `done` callback that never comes (verified against
// bun 1.3.14, sequential and concurrent describes alike), so the prefix
// cannot be scoped that way: describe bodies REGISTER, and registration must
// stay outside async context. Test bodies only RUN, which is why currentTest
// below can be an AsyncVariable.
//
// Known limitation this leaves: an ASYNC describe body suspends with its
// prefix pushed, so a sibling describe registering during that suspension
// inherits it ("A > B > y"). Sync describe bodies - every real-world case,
// and all this repo's - are unaffected.
//
// The RUN-time "which test is executing" is an AsyncContext.Variable
// (@b9g/async-context, AsyncLocalStorage under the hood): with concurrent
// tests (bun's test.concurrent, node's concurrency options) two interleaved
// async bodies would otherwise misattribute each other's toMatchSnapshot()
// keys through a shared global - silently writing the right snapshot under
// the wrong name. Context propagation follows each body's own await chain,
// so attribution holds no matter how tests interleave. This module only
// loads on node/bun (test.ts gates it), where async_hooks exists; the
// browser runner is sequential and has no snapshots.
// ---------------------------------------------------------------------------
const describeStack: string[] = [];
const currentTest = new AsyncVariable<string>({name: "libuild-current-test"});
// key = test full name (+ optional hint); value = how many snapshots taken so
// far in that test, so repeated toMatchSnapshot() calls get "name 1", "name 2".
const counters = new Map<string, number>();

function fullNameFor(name: unknown): string {
  const prefix = describeStack.join(" > ");
  return prefix ? `${prefix} > ${String(name)}` : String(name);
}

/**
 * Preserve a wrapper's arity. node:test dispatches callback-style
 * (`(t, done) => ...`) versus promise-style on `fn.length`, so a rest-args
 * wrapper reporting length 0 makes a callback test PASS INSTANTLY without
 * running its body - a silent false green.
 */
function withArity<T extends Function>(wrapper: T, original: Function): T {
  Object.defineProperty(wrapper, "length", { value: original.length, configurable: true });
  return wrapper;
}

// ---------------------------------------------------------------------------
// Registration count. A shard that dies mid-run can only report how many tests
// FINISHED; the total it was going to run is knowable only from inside the
// child, because both runtimes register every top-level test (running the file
// body) before executing any of them. So we count registrations here and print
// the total on stdout, where the parent parses it back out - giving a timeout
// message a denominator ("12 of 47 finished") instead of a bare numerator.
//
// Wire format shared with `internal/test-runner.ts` (REGISTERED_MARKER there); keep the
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
 * Wrap a test body so that, while it runs, the current-test variable reflects
 * it. The full name is captured HERE (at registration, when the describe stack
 * is populated), not when the body later runs. The variable's value follows
 * the body's own async chain, so concurrently-interleaved tests each see
 * their own name (no restore bookkeeping - context exits with the scope).
 */
function trackBody(name: unknown, fn: (...args: any[]) => any): (...args: any[]) => any {
  const fullName = fullNameFor(name);
  return withArity(function (this: any, ...args: any[]) {
    return currentTest.run(fullName, () => fn.apply(this, args));
  }, fn);
}

/** Wrap a describe body so nested test names carry the describe prefix. */
function trackSuite(name: unknown, fn: (...args: any[]) => any): (...args: any[]) => any {
  return withArity(function (this: any, ...args: any[]) {
    describeStack.push(String(name));
    let popped = false;
    const pop = () => { if (!popped) { popped = true; describeStack.pop(); } };
    try {
      const r = fn.apply(this, args);
      if (r && typeof r.then === "function") return Promise.resolve(r).finally(pop);
      pop();
      return r;
    } catch (e) {
      pop();
      throw e;
    }
  }, fn);
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
 * We intercept two things:
 *  - apply: wrap the registration body (wherever it sits in the argument
 *    list) so its name is tracked while it runs, and count the registration.
 *  - get: recursively wrap every function sub-method, so `.only`,
 *    `.concurrent`, `.skip`, `.todo`, `.failing`, `.skipIf`, and anything a
 *    future runtime adds all get the same treatment - including CHAINS like
 *    `test.concurrent.each`. `.each` is special-cased (it returns a
 *    registrar, and is synthesized when the runtime lacks it).
 *
 * `counts` marks the blocks that register a test (`test`/`it`, not
 * `describe`). skip/todo count too: both runtimes REPORT them, so the "x of
 * y" numerator includes them and an uncounted .skip would push the
 * denominator below the numerator.
 */
function wrapBlock(
  real: any,
  track: (name: unknown, fn: any) => any,
  counts = false,
  boundThis: any = undefined
): any {
  const proxy: any = new Proxy(real, {
    apply(target, thisArg, args) {
      if (counts) noteRegistration();
      // `boundThis` carries the PARENT block when this proxy came from a
      // sub-method read (see get): bun's sub-methods are branded and throw
      // unless called against the object they were read from.
      return Reflect.apply(target, boundThis ?? thisArg, trackArgs(args, track));
    },
    get(target, prop) {
      // `.each` is synthesized when the runtime lacks it (node:test has none),
      // so it is handled BEFORE the "is it a function" check.
      if (prop === "each") return eachFor(proxy, Reflect.get(target, prop, target));
      // Resolve against target (not the proxy) so bun's branded getters accept
      // `this`; a throwing getter (e.g. describe.failing, or .only under CI)
      // still throws only here, when the user actually reads it - exactly as
      // the native block would.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      // Recursively wrap, rather than rebuilding a bare function: a plain
      // `function (name, body) {...}` carries none of the target's own
      // properties, which silently destroyed every CHAIN (`test.concurrent
      // .each`, `test.skip.each`) - a TypeError at registration, which aborts
      // the rest of the file's registrations and can still report green.
      // Recursion also means sub-methods nobody enumerated (skipIf, todoIf,
      // future additions) get body tracking and registration counting for
      // free, instead of silently falling through untracked.
      return wrapBlock(value, track, counts, target);
    },
  });
  return proxy;
}

/**
 * Wrap the registration BODY in an argument list, wherever it sits.
 *
 * Runtimes accept several shapes: `(name, fn)`, node's `(name, options, fn)`,
 * and `(name)` alone for todo. The rule that covers all of them: the body is
 * the first function argument after the name. Missing the options form left
 * concurrent node bodies untracked - the exact misattribution this tracking
 * exists to prevent.
 */
function trackArgs(args: any[], track: (name: unknown, fn: any) => any): any[] {
  const bodyIndex = args.findIndex((a, i) => i >= 1 && typeof a === "function");
  if (bodyIndex === -1) return args;
  const copy = [...args];
  copy[bodyIndex] = track(args[0], args[bodyIndex]);
  return copy;
}

/**
 * `.each`, implemented once for every runtime rather than delegated.
 *
 * Delegating to a native `.each` left its rows untracked: the runtime formats
 * and registers them internally, so every row's snapshots keyed under one
 * shared bucket, numbered in EXECUTION order - fine sequentially, silently
 * order-dependent once rows interleave. Registering each row through this
 * same wrapped block instead gives every row its formatted name, a tracked
 * body, and an accurate registration count, identically on bun and node.
 */
function eachFor(block: any, _native: unknown) {
  return (table: unknown, ...tableRest: unknown[]) => {
    if (!Array.isArray(table)) {
      throw new TypeError(
        "libuild: each() expects an array table (template-literal tables are not supported)"
      );
    }
    if (tableRest.length > 0) {
      throw new TypeError("libuild: each() takes a single array table");
    }
    return (name: string, fn: (...args: any[]) => unknown, ...rest: any[]) => {
      table.forEach((row, index) => {
        const args = Array.isArray(row) ? row : [row];
        // Arity EXCLUDING the row values: both runtimes read a body's
        // declared length to decide whether it wants a `done` callback, and
        // the row values are already bound here - reporting the raw
        // `fn.length` made every row hang waiting for a done that never came.
        const rowBody = function (this: any, ...runnerArgs: any[]) {
          return fn.apply(this, [...args, ...runnerArgs]);
        };
        Object.defineProperty(rowBody, "length", {
          value: Math.max(0, fn.length - args.length),
          configurable: true,
        });
        block(formatEachName(String(name), args, index), rowBody, ...rest);
      });
    };
  };
}

/**
 * Format one `.each` row's name, jest-style. Positional printf tokens consume
 * row values in order; `%#` is the row index; `%%` a literal percent.
 * Unrecognized tokens and leftover values are left alone - names are labels,
 * and a rough label beats a throw during registration.
 */
export function formatEachName(name: string, row: unknown[], index: number): string {
  let i = 0;
  return name.replace(/%[%#psdifjo]/g, (token) => {
    if (token === "%%") return "%";
    if (token === "%#") return String(index);
    const value = i < row.length ? row[i++] : undefined;
    if (token === "%p" || token === "%j" || token === "%o") {
      try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
    }
    if (token === "%d" || token === "%i" || token === "%f") return String(Number(value));
    return String(value);
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
// Race-free because `toMatchSnapshot` is synchronous end to end - the
// read-modify-write never yields. (NOT because execution is sequential:
// concurrent tests interleave. If any step here ever becomes async, this
// needs real serialization.)
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

  const testName = currentTest.get() ?? "<unknown>";
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
