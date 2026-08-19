# Changelog

All notable changes to this project will be documented in this file.

## [0.2.21] - 2026-08-18

### Fixed
- **Relative JSON imports bundle into dist.** They were externalized without relocation, so the published package carried a `../*.json` specifier pointing above its own root - builds and publishes succeeded, only installed consumers broke. esbuild's JSON loader now bundles them (import attributes included).
- **`--timeout` now also sets bun's per-test timeout.** bun's 5s per-test default was killing slow tests long before the per-file budget applied.

### Changed
- **No more `.libuild-test/` in your project.** Test bundles live in a per-run temp directory under the OS tmpdir, with your `node_modules` ancestry symlink-mirrored so dependency resolution (hoisted workspaces included) is unchanged. Also fixes litter after crashed runs and a collision between simultaneous runs.
- **Builds are faster:** TypeScript's lib and dependency declarations are parsed once per process instead of once per build.
- The publish-guard message now says "Use libuild to publish or stage the package" instead of naming one workflow.

### Added
- **First-publish hint:** publishing a never-published name prints the `npm trust ... --allow-stage-publish` command that enables staged releases from CI - both that grant and staging itself require the package to exist, so the first publish is the only moment to learn it.
- README documentation for `libuild test` (flags, timeout semantics, runtime notes incl. bun's no-nested-test limitation).

## [0.2.20] - 2026-08-18

### Removed
- **The `.` / `./libuild` root export is gone: libuild is a CLI, not a library.** `build()`/`publish()` were never a designed API - the root export existed because zero-config discovery promoted a top-level implementation file. The implementation now lives in `src/internal/` (with the other internals: esbuild recovery, snapshots, the test runners) and the package surface is exactly the `libuild` bin plus `@b9g/libuild/test`. Importing `@b9g/libuild` now fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Main-entry detection no longer guesses.** With nothing declared (no `exports["."]`, `main`, `module`, or `index` entry, multiple entries, no name match), the build now emits NO root export instead of alphabetically electing one - the old fallback would have silently made `.` point at `cli.js` here. Single-entry and name-matching packages are unaffected.

### Added
- **Concurrent tests with correct snapshot attribution, via AsyncContext.** Run-time current-test tracking is now an `AsyncContext.Variable` (`@b9g/async-context`, the TC39-shaped shim over `AsyncLocalStorage`) instead of a module global, so interleaved test bodies each see their own name: `toMatchSnapshot()` inside `test.concurrent` (bun) or options-form `test(name, {concurrency}, fn)` (node) files each snapshot under its own key - previously concurrent bodies would have silently misattributed each other's snapshots through the shared global, and `.concurrent` bodies weren't name-tracked or registration-counted at all. `test.concurrent` is also shimmed where the runtime lacks it (node backend, browser runner) as plain registration - sequential execution is a conforming implementation of concurrent semantics - so bun-authored concurrent suites run unchanged everywhere. Adds a `@b9g/async-context` dependency; `node:async_hooks` joins the browser-bundle stubs. `.each` is now implemented once by libuild for every runtime rather than delegated: rows register through the wrapped block, so each row gets its formatted name, a tracked body, and an accurate count identically on bun and node (delegating left rows sharing one snapshot bucket numbered in execution order - fine sequentially, order-dependent under concurrency). Sub-methods are wrapped recursively, so chains (`test.concurrent.each`, `test.skip.each`) survive and runtime-specific variants (`skipIf`, `todoIf`) get tracking for free.

  **Known limitation:** an `async` describe body suspends with its prefix pushed, so a sibling describe registering during that suspension inherits it. The prefix cannot be async-scoped: registering a `bun:test` test from inside an `AsyncLocalStorage` scope makes bun hang waiting for a `done` callback (verified on bun 1.3.14). Sync describe bodies - every real-world case - are unaffected.
- **`libuild stage`: staged publishing as its own command.** Builds and runs `npm stage publish` inside `dist/` - the version is uploaded to the registry in a not-installable state until a human runs `npm stage approve <stage-id>`, which always prompts for 2FA and therefore cannot be automated. A separate command rather than a `publish` flag: staging is a different operation, not a variant - the artifact does not go live. Shares publish's whitelist-validated flag parsing, `--access public` for scoped names, and `--save` semantics. Two preflights fail fast with clear errors before anything builds: staged publishing needs npm >= 11.15.0, and the package must already exist on the registry (a first release must be a normal `libuild publish`). The release workflow now runs `libuild stage --provenance`, so with a stage-only trusted publisher CI can never make a version live on its own.

### Changed
- **libuild's own suite is self-hosted: `npm test` runs it through `libuild test` on bun AND node.** "libuild works under node" is now a gate, not a claim - and the migration immediately caught four runner bugs consumers would have hit (below: `__dirname`, the require-shim collision, `NODE_TEST_CONTEXT` inheritance, and the missing concurrency knob). Raw `bun test` still works (`test:bun`): the suite imports the platform dispatcher, which picks bun's backend natively there.

### Added
- **`--concurrency <n>`: max test files running at once per platform** (default: CPU count - 1). A suite whose every test spawns its own processes (builds, servers) multiplies at full parallelism and starves itself - libuild's own suite runs at 4.

### Fixed
- **`__dirname` / `__filename` work in test files** - raw bun provides the CJS globals even in transpiled TS, so jest-heritage suites are full of them, and ESM bundles have neither. They join the per-file `import.meta` rewrite, pointing at each source file's real location.
- **The require-shim banner no longer collides with consumer imports of `createRequire`** - the banner now imports `node:module` under a private namespace, so a test file (or its imports) using `createRequire` itself bundles cleanly.
- **Spawned `node --test` shards no longer inherit `NODE_TEST_CONTEXT`** - when libuild test is itself invoked from inside a node:test run, the inherited marker made every child conclude it was recursing and exit 0 having run nothing ("skipping running files"); the completed-guard turned that into loud failures, but now it just works. The env var is stripped from shard environments.
- **`import.meta.url` / `.dirname` / `.filename` point at the source test file, not the bundle** (reported by the fold migration). Bundling collapsed every module's location to `.libuild-test/bundle-*.js`, silently breaking the fixtures-next-to-the-test pattern (`new URL("./fixtures/x.json", import.meta.url)`) with failures that read as bugs in the code under test. On node/bun bundles, esbuild's `define` now maps the three path-shaped members to per-file bindings injected (one line, no line-number shift) into each file that mentions `import.meta`. Browser bundles are unchanged - a page has no source filesystem. (`import.meta` used bare, or other properties, still see the bundle.)
- **A file that registers no tests counts as `0 passed`, not `1`** (fold's `tests/helpers.js`). node fabricates one passing test named with the file's path when a file registers nothing, and includes it in `# pass`; the synthetic entry is now recognized and excluded, so shared helpers swept up by the test glob report honestly.

### Changed
- **`typescript` peer range widened to `^5.0.0 || ^6.0.0`** - installs alongside TypeScript 6 no longer ERESOLVE.

## [0.2.19] - 2026-08-12

### Fixed
- **Browser timeout is stall-based, not an absolute deadline** (crank #375, firefox). `--timeout` means per-file on node/bun, but the browser runs the whole suite as one bundle - a single absolute deadline meant a 30-file suite (browser launch included) had to finish in one file's allowance, so large suites "timed out" at the default while making steady progress. Progress - the entry's ready flag, the runner starting, each completed test - now resets the clock; `timeout` ms with NO progress is a genuine hang. Crank's 602-test suite passes on firefox at the default timeout. (Measured while diagnosing: firefox's cost is ~8s of launch overhead, not bundle parsing - the 1.6MB bundle parses in under 600ms.)
- **Uncaught page errors are phase-aware; mid-run unhandled rejections no longer fail the run.** 0.2.17 failed the run on ANY `pageerror`, but browsers don't agree on what reaches it - firefox surfaces unhandled rejections there, chromium/webkit don't - so suites that deliberately float rejections to test error propagation (crank's async generators) failed on firefox only, with a message ("tests registered after this error never ran") their own registration counts disproved. Uncaught errors are now captured in the page, where phase is known synchronously: before the runner starts, registration was genuinely cut short - red; during the run (module bodies are complete by ESM guarantee), nothing was lost - a yellow warning. Identical behavior on all three browsers.
- **A bundle that throws during load fails in seconds, naming the error** - a module-body throw means the runner can never start, so the harness no longer waits out the full timeout in silence.
- **Browser runner: a failing test no longer skips its own `afterEach`** (#25). Cleanup hooks now run in all cases (each individually guarded, the test's own error kept as the reported failure), matching node:test/bun:test. Skipping cleanup on failure compounds: one real failure left a `console.error` stub installed and crank's webkit run reported 23 failures for 1 bug, burying the real assertion text.

## [0.2.18] - 2026-08-12

### Fixed
- **node backend: a throw during suite registration is a named failure instead of a dropped-green run** (#23). An exception in a `describe()` callback body (registration time, not inside a test) appears in node's TAP stream as a `not ok` suite entry - but node counts it under `# suites` rather than `# fail` and still exits 0, so the runner reported green while every test declared after the throw silently never registered. In one real migration (crank's eslint-plugin, PR bikeshaving/crank#376), nine such sites made a 126-test suite report "95 passed, 0 failed" on node. The TAP parser now processes each entry's full YAML block and counts suites with `failureType: 'testCodeFailure'` as failures, surfacing the actual thrown error; suites that are `not ok` merely because a child failed (`'subtestsFailed'`) are excluded, so ordinary failures aren't double-counted through their parents. Failing tests also now carry their real `error:` text in the summary instead of a generic label.

### Added
- **`test.each` / `it.each` / `describe.each` on the node backend** (#23). bun:test and jest have `.each`; node:test does not - and it's the single most likely API to bite a suite moving over from `bun test`, precisely because the resulting `TypeError` sat inside `describe()` callbacks where the bug above swallowed it. Each table row registers one ordinary test, so snapshot name-tracking and registration counting see plain calls; row names support the positional printf tokens (`%i`/`%s`/`%d`/`%f`/`%p`/`%j`/`%o`/`%#`/`%%`). Array tables only (template-literal tables throw with a clear message), attached only when the runtime lacks `.each`, so a future node:test implementation wins.

### Changed
- **libuild is ESM-only, stated as policy and enforced (#21).** Source entrypoints are ES modules; `.mjs`/`.cjs`/`.mts`/`.cts` entrypoints are not supported; CommonJS exists solely as the `main`-field fallback artifact the build emits. A package that explicitly declares `"type": "commonjs"` is now refused by **both** `libuild build` and `libuild test` (all platforms) with a one-line fix: set `"type": "module"`. Previously such packages half-worked - node/bun test runs passed incidentally while browser bundles died as an esbuild syntax error (esbuild classifies files in a commonjs-typed package as CJS from the package `type` even when they use `import` syntax, which puts the test dispatcher's required `await init_...()` inside a non-async wrapper). Partial support is still support, and worse, unreliable support; #21's namespace-plugin workaround was considered and rejected as quiet reinterpretation of an explicit declaration. Packages with **no** `type` field are unaffected: nothing was declared, and every tool involved classifies files by their own syntax.
- **Test bundles are plain `.js` again; the bundle directory declares itself ESM.** 0.2.17's `.mjs` bundle extension is replaced by a `{"type": "module"}` package.json written into `.libuild-test/` - one statement of the policy instead of per-file extension encoding. Bundles still load as ESM under node in consumers without a `type` of their own, and the generated entry is classified ESM by esbuild for the same reason.
- **Build errors exit with a one-line message instead of an unhandled-rejection stack dump.**

## [0.2.17] - 2026-08-12

### Fixed
- **Browser test bundles no longer break from live `bun:test`/`node:test` imports.** `@b9g/libuild/test`'s never-run node/bun branches were marked `external` in browser bundles, surviving as live dynamic imports. That forced esbuild to give the dispatcher a lazy async wrapper, and — depending on the esbuild version's wrapper choice — the resulting `await init_test()` could land inside a non-async wrapper, making the entire bundle a syntax error before a single test ran (every browser run then died on Playwright's 30s timeout). Those specifiers now resolve inside the bundle to stubs whose module bodies throw: they link cleanly, the dispatcher stays plain ESM with its top-level await at genuine top level, and a browser-dead code path that ever actually evaluates one fails loudly.
- **Browser runner no longer starts before all tests register** (crank PR #375). The dispatcher's top-level await makes it an async module, so every importing test file's body is deferred past the runner's old `queueMicrotask` start — it ran with zero tests registered and reported a green empty run. Scheduler-based starts (a `setTimeout` included) all lose some race with top-level await, so the generated entry now sets a ready flag as its **last statement** — ESM guarantees that runs only after every imported test file, including TLA continuations spanning any number of macrotasks, has fully evaluated — and the runner waits on that flag. The runner also sweeps for tests registered during or just after the run instead of iterating a fixed snapshot.
- **Uncaught page errors fail the browser run, even when tests passed around them.** In a single browser bundle, one file throwing during load aborts every later file's registrations while earlier tests still run — previously that was `N passed, 0 failed`, exit 0, with the real cause visible only as a log line. Page errors are now part of the result, and a bundle that breaks before the runner starts is reported as a platform failure carrying those errors (instead of an uncaught Playwright timeout crashing the CLI and leaking the browser process).
- **A browser run that registers zero tests is a hard failure, not a green exit 0** (crank PR #375). Discovered-files-but-nothing-registered would merge as "suite silently disabled, CI green". A genuinely empty run (no files found) still exits 0, and all-skipped files count as skipped, not as zero.
- **The browser runner now has `test.skip`/`test.todo`/`describe.skip`.** They were missing entirely, so a file shared with node/bun that used them died with a `TypeError` mid-load — killing every registration after it in the bundle. They register nothing and tally into the run's skipped count.
- **`libuild test test/` discovers files without the `.test.` infix.** A single directory argument becomes the discovery root, and the `**/test/**` default glob evaluated from *inside* a directory named `test` demands a nested `test/test/` — so files that only matched by living under a test directory (crank's `test/dom.tsx`) stopped matching the moment you pointed at that directory. When the root itself is named `test`/`tests`/`__tests__`, everything under it now counts, same as the parent-rooted glob always claimed.
- **Browser stubs are scoped to libuild's own imports.** `expect` and `pretty-format` were stubbed for the whole bundle graph, so a consumer's browser test importing them for itself got a libuild-branded throw instead of the real package. Only libuild's internal imports are stubbed now (matched by the package's resolved realpath, so linked installs behave); node builtins and `bun:test`/`node:test` stay stubbed globally — they can never meaningfully resolve in a browser bundle, and the deferred throw is what keeps consumers' runtime-guarded `await import("fs")` patterns building.
- **`--platform node` works in packages without `"type": "module"`.** Test bundles for node/bun are now written as `.mjs`, so node's format detection no longer falls back to the consumer's package `type` and refuse the ESM bundle ("Cannot use import statement outside a module").
- **A dead esbuild service no longer cascades into every remaining build.** esbuild keeps one long-lived service child per process and never respawns it: if that child dies (OOM, reaped under load), every later `build()` fails forever — in libuild's own suite, one such death turned a green run into 139 failures. All builds now go through a wrapper that recovers by calling `esbuild.stop()` (dropping the dead handle so the retry spawns a fresh service) and retrying once. Recovery is **single-flight** via a service-generation counter: the runner races many concurrent builds, and if each failing caller ran its own `stop()`, the second would kill the fresh service the first retry just spawned — and esbuild strands (never settles) requests in flight on a stopped service, so that would hang the run forever. Both death spellings are matched: builds started after the death get "The service is no longer running", builds in flight when it died get "The service was stopped". Ordinary build errors are not retried.

### Added
- **Timeout failures report "x of y": how many tests finished out of how many the file registered.** `@b9g/libuild/test` counts registrations as they happen (in the same proxy that tracks names for snapshots) and emits the total on stdout, where the runner parses it back out and strips it from displayed output. A timed-out file now reports `40 of 47 test(s) finished` instead of a bare `40`. The count covers `test`/`it` plus `.only`/`.skip`/`.todo`/`.failing` and `.each` (one per table row), matching what the runtimes report (bun's skip/todo summary lines are now parsed into the numerator too); if an unwrapped registration path ever makes the denominator inconsistent, it is suppressed rather than shown wrong. The marker is parsed and stripped only as a full line, so a test's own output mentioning it can neither hijack the count nor vanish from failure dumps. Files that don't import `@b9g/libuild/test` keep the numerator-only message, and a shard that finishes cleanly right at the timeout buzzer is not misreported as timed out.

## [0.2.16] - 2026-08-11

### Fixed
- **A test file that exceeds the timeout is now a failure instead of quietly vanishing from a green run** (#18). When a file blew the per-file budget, `libuild test` stayed green and the file's remaining tests simply didn't appear in the totals — nothing failed, nothing named the file, and the only way to notice was knowing what the count should have been. The cause: the timeout was enforced by `spawn`'s own `timeout` option and then *reconstructed* afterwards from the exit status. That reconstruction is impossible for node, which traps the resulting `SIGTERM` and exits `(code 1, signal null)` after printing valid TAP for the tests it did finish — indistinguishable by exit status from an ordinary failing run, so the check (which looked only at "did we see test lines" and "was there a signal") read it as a clean partial pass. libuild now enforces the timeout itself, so "we killed this for running too long" is a fact it records rather than infers, and escalates to `SIGKILL` after a grace period so a runner that traps `SIGTERM` can't hang the suite. A timed-out shard is reported red, names the file, and states how many of its tests finished before the timeout. The exit-status check also no longer trusts a completed-looking run that exited non-zero while reporting no failing test — that means tests went missing somewhere invisible (an unhandled rejection, a runner-level error), which is red, not green.

### Added
- **`libuild test` accepts test files and globs, not just a directory** (#19). The smallest runnable unit used to be "every test file under the directory", so iterating on one file meant paying the full-suite cost, or dropping to `bun test path/to/file.test.ts` — which runs under bun's harness instead of libuild's, silently skipping the node platform, and doesn't apply libuild's loader. Now `libuild test path/to/file.test.ts` (one file, several files, or a quoted glob like `'test/**/*-snapshot.test.ts'`) runs exactly that selection under the same loader, setup file, and platforms as the directory form. A single directory argument keeps its original meaning. `--filter <patterns...>` does the same by glob. The setup file (`test-setup.test.*`) is always discovered with the full default globs rather than the selection patterns, so narrowing what you run never silently drops your preload. A selection that matches nothing exits non-zero rather than reporting a green empty run, and a mistyped path is a clear error instead of a silent no-op.

## [0.2.15] - 2026-08-06 — SKIPPED (Claude error)

Never published: Claude bumped straight to `0.2.16` without checking that `0.2.15` had shipped. npm goes `0.2.14` → `0.2.16`; the change below shipped in **0.2.16**.

### Added
- **Colored test output.** `libuild test` now colors its per-file lines and the results summary (green pass, red fail, yellow todo, dim skipped), and — because each test file runs in its own child process whose output libuild captures over a pipe — it forwards `FORCE_COLOR` to those children so their own failure detail (e.g. bun's assertion diffs) stays colored too. Zero-config and no flag: color is on when stdout is a TTY and off when piped or redirected, honoring the standard `NO_COLOR` (force off) and `FORCE_COLOR` (force on) environment variables. Child summaries are ANSI-stripped before the pass/fail counts are parsed, so forced color never corrupts the tallies. (An earlier build emitted summary color codes unconditionally, even when piped; that's now gated on the same detection.)

## [0.2.14] - 2026-08-05

### Fixed
- **Snapshot test wrapper no longer depends on the runner's object shape (fixes bun `test.todo`/`.skip`/`.only`/`.each`).** The wrapper that tracks test names for snapshot keys used to enumerate and copy each block's sub-methods, which coupled it to how each runtime exposes them and broke twice on bun: 0.2.12's own-property copy missed bun's prototype-based sub-methods (so `test.todo` threw and aborted the file), and 0.2.13's prototype-walk then read bun's `describe.failing`, a getter that throws for `describe`, crashing at module import. The wrapper is now a `Proxy` that forwards access lazily, so prototype-vs-own, throwing getters, and future sub-methods all behave as the native block with nothing read at import. bun's sub-methods are additionally *branded* (getters on `ScopeFunctions.prototype` that require `this instanceof ScopeFunctions` both when read and when called), so the proxy resolves each getter against the real target and binds the result to it; node's plain data properties are unaffected. Only two things are intercepted: calling a block (to name-track its body) and reading `.only` (whose body also runs). Verified end-to-end against a real consumer suite on both runtimes (bun and node) without the workaround.

## [0.2.13] - 2026-08-05

### Fixed
- **Snapshot test wrapper no longer drops `test.todo`/`.skip`/`.only`/`.each` on bun.** 0.2.12's `toMatchSnapshot` wraps `describe`/`test`/`it` to track the current test name, copying their sub-methods with `Object.getOwnPropertyNames`. bun exposes those sub-methods on the **prototype**, not as own properties, so the copy found only `length`/`name` and dropped them all — every bun test file calling `test.todo(...)` (etc.) then threw `undefined is not a function` and aborted the rest of that file, silently reducing the bun test count. (node exposes them as own properties, so node was unaffected.) The wrapper now walks the prototype chain, covering both runtimes.

## [0.2.12] - 2026-08-01

Everything since 0.2.11 (the last published release). Interim `0.2.12` and `0.2.13` were committed during development but never published, so their changes ship here under a single version rather than leaving npm with a gap.

### Added
- **Portable `toMatchSnapshot` across bun and node.** `@b9g/libuild/test` now installs one snapshot matcher that overrides each runtime's native/absent support, so `expect(value).toMatchSnapshot()` writes and verifies the **same** `.snap` files on both platforms — previously it passed on bun (its native matcher) and threw on node (`toMatchSnapshot is not a function`). Snapshots live in `__snapshots__/<file>.snap` next to the source test, in a jest-compatible format written and parsed without `eval`. Strings are stored verbatim (the rendered-output case); other values serialize via `pretty-format`. Keys are the jest-style `<describe > test> <n>`, tracked by wrapping `describe`/`test`/`it`. Update stale snapshots with `libuild test -u` (`--update-snapshots`). The exported `expect` type now includes `toMatchSnapshot`, so it typechecks. Browsers have no filesystem, so their `toMatchSnapshot` throws a clear "not supported on the browser platform" error (bun/node parity covers the use case). Adds a `pretty-format` dependency.

### Changed (BREAKING)
- **One public test entrypoint: `@b9g/libuild/test`.** The platform shims `@b9g/libuild/test-bun`, `/test-node`, and `/test-browser` (and their `.js` aliases) are removed. `test-bun`/`test-node` were trivial wrappers over `bun:test` and `node:test`+`expect`; they're collapsed into the single dispatcher, and the browser runner is now an internal chunk (`_test-browser`). `@b9g/libuild/test` detects the runtime (`typeof Bun` / `typeof process` — a real browser has no `process`, which distinguishes it from node+jsdom) and loads the right backend directly, so bun/node use their own builtins rather than a libuild module. Consumers import from `@b9g/libuild/test` exactly as before — only the internal sub-paths are gone.
- **The test runner is now internal — `@b9g/libuild/test-runner` is no longer a public export.** It exposed the runner machinery plus a pile of helpers only meant for libuild's own unit tests (`bundleTests`, `collectTests`, `parseTapOutput`, etc.) and a dead `detectPlatforms()`. Every public export is a liability; the runner was never a deliberate consumer contract. The public test surface remains `@b9g/libuild/test` (the `describe`/`test`/`expect` API). `detectPlatforms()` is removed.

### Fixed
- **Setup file now recognized for the `.spec.` convention, not just `.test.`.** Test discovery accepts both `*.test.*` and `*.spec.*`, but setup recognition only matched `test-setup.test.*` — so a `.spec.`-convention project's `test-setup.spec.ts` was silently run as an ordinary (test-less) shard and set up nothing for the other files. Both `test-setup.test.*` and `test-setup.spec.*` are now recognized.
- **Browser test bundles now build.** The browser target was `es2020`, which can't emit the top-level `await` the `@b9g/libuild/test` dispatcher now uses to select its backend — so `-p chromium/firefox/webkit` failed to bundle. Bumped to `es2022`, which every Playwright-driven browser supports.

### Removed
- **`libuild test --watch`** — the flag was wired up but never did anything (a no-op). Removed rather than left advertising behavior it doesn't have.

### Notes
- `--timeout` is **per file** (each file runs in its own process as of 0.2.10), not a whole-suite budget. Browser, which still runs a combined bundle, applies it per run.

## [0.2.11] - 2026-07-28

### Changed (BREAKING)
- **Test setup file renamed to `test-setup.test.{ts,tsx,js,jsx}`, discovered anywhere your tests are.** The `test/test-setup.*` convention from 0.2.7 was inconsistent: test files are discovered by glob (`*.test.*` co-located anywhere, or under `test/`), but the setup file was pinned to a hardcoded `test/` location — so a project that co-locates tests in `src/` had nowhere to put one. The setup file now carries the `.test.` infix, so it's a `*.test.*` match found by the **same** discovery as every other test file — wherever your tests live — then recognized by name, excluded from the run, and imported first. One discovery mechanism, not two. More than one `test-setup.test.*` is now an error (one global setup is the model). **Migration:** rename `test/test-setup.ts` → `test/test-setup.test.ts` (or place it beside your tests anywhere).

## [0.2.10] - 2026-07-28

### Changed
- **`libuild test` runs each test file in its own process (per-file isolation, now the default).** Previously every file was bundled into one process per platform. For runtimes that don't return native/off-heap memory to the OS mid-process (bun/JSC), a large jsdom-backed suite grew until it thrashed and never finished; node (V8) reclaimed and passed the same bundle. Each file now bundles and runs in its own process (reusing the setup-file injection and externalization), so native memory is freed between files; independent files run in parallel bounded to ~`cpus-1`. Results aggregate across files into the per-platform summary, and per-file lines report as each finishes. No flag — this is just how the runner works. Browser keeps its single-page Playwright execution. Resolves [#16](https://github.com/bikeshaving/libuild/issues/16).

## [0.2.9] - 2026-07-28

### Fixed
- **A killed or crashed test child was reported as a green pass** - `runNodeTests`/`runBunTests` ignored the child's exit code and signal, and the parsers returned `0 passed, 0 failed` when a run was killed (spawn timeout / OOM) or crashed before printing a summary — which `printResults` then treated as success (exit 0). A run in which zero tests completed could report green. The runners now require a parsed result summary AND no kill signal to count as success; a killed/incomplete child is a failure naming the reason. Groundwork for per-file process isolation ([#16](https://github.com/bikeshaving/libuild/issues/16)), where a killed shard must count as a failure.

## [0.2.8] - 2026-07-28

### Fixed
- **`libuild test` reported node `test.todo`/skipped tests as failures** - `parseTapOutput` counted every TAP `not ok` line as a failure, ignoring the trailing directive. Node emits `test.todo` as `not ok N - name # TODO` and skipped tests as `# SKIP`, so a run node itself reports as green (`# fail 0`) printed a false red (e.g. "466 passed, 26 failed" for a suite with 25 todo + 1 skip). The parser now honors `# TODO`/`# SKIP` directives (ignoring an escaped `\#` inside a test name), prefers node's authoritative `# pass`/`# fail`/`# todo`/`# skipped` summary lines for the counts, and lists only genuine failures. Todo/skip counts are surfaced in the summary and no longer stream as `✗`. Bun's path was already correct. Fixes [#15](https://github.com/bikeshaving/libuild/issues/15).

## [0.2.7] - 2026-07-28

### Added
- **Test setup/preload file** - If `test/test-setup.{ts,tsx,js,jsx}` exists, it is imported once at the top of the generated test entry, before any test files, on every platform (bun, node, browsers). Use it to register global `beforeEach`/`afterEach` hooks, install polyfills, or do environment setup that must run ahead of the suite. There is no config or flag - it's a single conventional file, discovered like the tests themselves and excluded from the run so it isn't executed as a test. Platform-specific behavior lives inside the one file via runtime detection (e.g. `if (typeof Bun !== "undefined") { ... }`), since all tests share a single bundle per platform. Resolves [#13](https://github.com/bikeshaving/libuild/issues/13).

## [0.2.6] - 2026-07-28

### Fixed
- **`libuild test` bundled all dependencies for node/bun, breaking bundle-hostile packages** - The test runner inlined every `node_modules` dependency into the test bundle. For the `node` and `bun` platforms this both broke un-bundleable deps (jsdom spawns a worker thread from `xhr-sync-worker.js` via `require.resolve`, which no longer resolves once inlined) and was unnecessary, since those runtimes resolve deps from `node_modules` directly. Node/bun bundles now externalize `node_modules` (`packages: "external"`, matching the library build); only the browser platform still bundles, since it has no `node_modules` at runtime. Fixes [#12](https://github.com/bikeshaving/libuild/issues/12).

### Changed
- **Test bundles for node/bun now use the runtime's module interop, not esbuild's.** Because deps are external, Node's stricter ESM/CJS interop applies in test code just as it does for consumers of the built package - so a default-only CJS export must be imported as a default (`import Terminal from "@xterm/headless"`), not via named imports. This surfaces interop mismatches in tests instead of hiding them behind esbuild's looser bundled interop. A corollary: a test that imports the package under test *by its own name* now resolves it from `node_modules` at runtime, so the package must be built/linked (previously it could be pulled from source by the bundler).

## [0.2.5] - 2026-07-26

### Fixed
- **Relocated subdirectory declarations excluded from the published package** - When the author kept a `files` field, the generated dist whitelist only matched flat output (`*.d.ts` etc.), so declaration trees relocated from src/ subdirectories (`dist/internal/*.d.ts`) were silently excluded by `npm pack` while `index.d.ts` still imported them - consumers got a package whose types failed to resolve. Each dist subdirectory holding relocated declarations is now whitelisted. Fixes [#11](https://github.com/bikeshaving/libuild/issues/11).

## [0.2.4] - 2026-07-25

### Fixed
- **`--save` silently dropped author-added export conditions from root package.json** - The root write-back only handled one level of string values when rewriting exports to `./dist/` paths, so a nested condition object (e.g. a hand-authored `browser: { types, import, require }`) was discarded without warning. The rewrite now recurses through nested conditions (and fallback arrays), preserving custom conditions and their order across the `--save` round-trip.

## [0.2.3] - 2026-07-25

### Fixed
- **User-authored export condition order not preserved** - Condition order is spec-significant (Node and bundlers match conditions top to bottom, first wins), but the exports generator reordered merged export objects: a custom condition the author placed before `import`/`require` (e.g. `browser`) came out after `import`, making it dead code for ESM bundlers. Expanding/filling an existing export now preserves the author's relative order; fabricated conditions slot in around it (`types` first, `default` kept last).

## [0.2.2] - 2026-07-25

### Fixed
- **UMD bundle broken in both browser and require modes** - The UMD wrapper enclosed esbuild's CJS output without neutralizing its internal `module.exports =` assignment or capturing a return value. In a browser `<script>` the bare `module.exports` threw `ReferenceError: module is not defined` before the global was ever assigned; under `require()` the factory wrote to the real module then returned `undefined`, which the wrapper assigned back over the exports. The factory now gets its own CommonJS shim (`var module = { exports: {} }`) and returns `module.exports`, so AMD, CJS, and browser-global modes all work.

## [0.2.1] - 2026-07-25

### Fixed
- **Broken types path for typeless export subpaths** - An exports entry with no types and no matching entry (e.g. a UMD-only subpath like `"./umd": {"require": "./dist/umd.js"}`) came out of the build as `{"types": "./undefined.d.ts", ...}`, pointing at a nonexistent file. Fabricated `types` conditions are now only emitted when the corresponding `.d.ts` actually exists, and exports with no entry to fill from pass through untouched.

## [0.2.0] - 2026-07-17

### Changed (BREAKING)
- **Flat output layout** - Modules now publish at the package root (`<pkg>/index.js`) instead of nested under `src/` (`<pkg>/src/index.js`). Direct CDN file URLs (jsDelivr, unpkg) serve literal paths and do not consult the exports map, so the old layout 404'd copy-paste URLs like `cdn.jsdelivr.net/npm/<pkg>/index.js`. Executables stay under `bin/`, code-splitting chunks move to `_chunks/` (was `src/_chunks/`). Fixes [#9](https://github.com/bikeshaving/libuild/issues/9).
- **Old `src/` paths break on republish** - This is a clean break: no compatibility layer ships. Literal deep URLs into previously published packages (`cdn.jsdelivr.net/npm/<pkg>/src/index.js`) 404 once the package republishes with 0.2.0. Node consumers are unaffected: exports-map keys never contained `src/`, and bare specifiers resolve through the regenerated map.
- **`--save` paths** - Root package.json now points at `./dist/<entry>.*` (was `./dist/src/<entry>.*`). Old saved paths are migrated automatically on the next `--save` run.
- **Node 20 floor** - Build target raised from `node18` to `node20` (Node 18 is EOL since April 2025), and libuild itself now requires Node >=20.10.0. Emitted output may use syntax unsupported by Node 18.

### Added
- **`.tsx` entry points** - Top-level `.tsx` files in `src/` are now discovered as entry points. esbuild and the declaration generator honor the project's tsconfig `jsx`/`jsxImportSource` settings (or `/** @jsx */` pragmas); declarations fall back to `jsx: preserve`. Fixes [#6](https://github.com/bikeshaving/libuild/issues/6).

### Fixed
- **UMD build corrupted sibling entries** - The UMD wrapper was applied to every `.js` file in the output directory, silently wrapping (and breaking) other entry modules in packages with a `src/umd.ts`. It now wraps only the UMD output file.
- **`--save` bin pointed at stale nested paths** - Saved bin paths are normalized to the flat artifact locations.
- **`--save` dropped the `import` condition from the `.` export** - A types-only `"."` export passed through without its `import` (and `require`) conditions, breaking bundler resolution of symlinked packages. Missing conditions are now filled in from the main entry. Fixes [#7](https://github.com/bikeshaving/libuild/issues/7).
- **npm flag filtering restored on `libuild publish`** - The flag whitelist from the original security hardening was silently dropped in the commander CLI rewrite; unknown or unsafe npm flags are again warned about and stripped instead of being forwarded (or hard-crashing the publish).

### Maintenance
- **esbuild `^0.19` → `^0.28`**, commander 15, dependency patch bumps.
- Removed dead code paths (unreachable `src/bin` entry flavor, unused parameters).

## [0.1.25] - 2026-07-14

### Fixed
- **CJS build bundled npm dependencies inline** - The CJS build was missing `packages: "external"`, so it bundled every bare-specifier import — including `peerDependencies` — into the `.cjs` output, while the ESM build correctly externalized them. Consumers of the CJS entry got a second copy of each peer package, and builds failed with `Could not resolve` in CI when a peer's `dist/` wasn't present. Fixes [#8](https://github.com/bikeshaving/libuild/issues/8).

## [0.1.24] - 2026-02-21

### Fixed
- **Bin exports not rewritten for dist** - `fixExportsForDist` now handles `./dist/bin/` → `./bin/` paths, matching the existing `./dist/src/` → `./src/` behavior. Previously, packages with bin exports would publish with broken import paths in the exports map.

## [0.1.23] - 2026-02-20

### Added
- **Cross-platform test runner** - Test runner with Bun, Node, and browser support (#3)

## [0.1.22] - 2025-12-22

### Fixed
- **Bin imports from src polluting source tree** - Fixed .d.ts files being emitted to source directories when bin entries import from `../src/`. This caused lint failures and polluted the src/ folder. Fixes [#2](https://github.com/bikeshaving/libuild/issues/2).

## [0.1.21] - 2025-12-22

### Fixed
- **Internal module .d.ts generation** - Fixed issue where .d.ts files were not generated for internal modules (e.g., `src/impl/utils.ts`), causing broken import paths in published packages. TypeScript now follows imports to generate declarations for all modules, not just entry points.
- **Module augmentation in .d.ts** - Fixed `declare module` blocks (module augmentation) not appearing in published type definitions. This resolves [#1](https://github.com/bikeshaving/libuild/issues/1).
- **Symlink path consistency** - Fixed path mismatches on macOS where `/tmp` symlinks to `/private/tmp`, which could cause .d.ts files to be emitted to wrong locations.

### Changed
- **Chunk files location** - ESM code splitting chunks are now placed in `dist/src/_chunks/` instead of the dist root, keeping the package structure cleaner.

## [0.1.20] - 2025-12-08

### Fixed
- **Ambient .d.ts export validation** - Fixed validation error when using `--save` with ambient .d.ts files. The build now correctly handles both `./src/` and `./dist/src/` paths for ambient declarations in exports.

## [0.1.19] - 2025-12-08

### Added
- **Ambient .d.ts exports** - Ambient TypeScript declaration files (*.d.ts) in src/ are now automatically added to the exports map, making them discoverable and importable by consumers.
- **Triple-slash references for ambient types** - Generated .d.ts files now include triple-slash reference directives to ambient .d.ts files, ensuring TypeScript can find ambient type declarations.

### Fixed
- **Hard fail on invalid workspace package.json** - Invalid JSON in workspace dependencies now causes build to fail immediately with clear error instead of silently continuing with a warning.

## [0.1.18] - 2025-12-02

### Changed
- **BREAKING: Scripts not copied to dist** - Scripts field is no longer copied to dist/package.json as they don't work correctly in the dist context (can't reference other scripts that were filtered out). This fixes the issue where prepublishOnly guards would block `libuild publish`. Users who need install scripts (postinstall, etc.) can manually add them to dist/package.json if needed.
- **prepublishOnly guards for root** - Root package.json gets `prepublishOnly` guard (via `--save`) to prevent accidental publishing from root directory.
- **Copy private field** - The `private` field is now properly copied from root to dist/, enabling actual private packages to work with libuild while npm prevents their publication.

## [0.1.17] - 2025-11-25

### Added
- **Ambient .d.ts file copying** - Hand-written ambient TypeScript declaration files (e.g., global.d.ts with `declare module` statements) are now automatically copied from src/ to dist/src/ during build. These files are automatically discovered by TypeScript when the package is consumed, providing global type declarations for module augmentation.

### Fixed
- **Non-deterministic export field ordering** - Fixed issue where package.json exports fields (types/import/require) would reorder non-deterministically across rebuilds with --save flag, causing unnecessary git diffs. All builds now consistently use types-first ordering.

## [0.1.16] - 2025-01-14

### Added
- **Code splitting for dynamic imports** - ESM builds now use ESBuild's `splitting: true` to create separate chunk files for dynamically imported modules, enabling lazy loading and reducing initial bundle size
- **Smart entry point detection** - Packages with only "." or bin exports build only index.ts as entry point, allowing subdirectory files to be chunked when dynamically imported
- **Code splitting warning** - Warns when dual-format builds have chunks, informing users that CommonJS builds cannot benefit from code splitting (CJS bundles dynamic imports inline)

### Fixed
- **Export validation** - Invalid export paths that don't point to src/ files are now properly validated and rejected with clear error messages

## [0.1.15] - 2025-01-14

### Fixed
- **Support bin-only packages** - Packages with only bin/ executables and no src/ library code no longer crash. Main/module/types fields and "." export are now correctly omitted for bin-only packages, while bin exports are properly generated.

## [0.1.14] - 2025-01-14

### Fixed
- **Eliminate stderr noise from dual-purpose shebang** - Changed from `//bin/true` to standard polyglot pattern `':' //;` to prevent shell from attempting to execute non-existent path, eliminating "No such file or directory" errors while maintaining dual runtime detection

## [0.1.13] - 2025-01-14

### Fixed
- **Dual runtime shebang for src/ executables** - src/ files referenced in package.json bin field now correctly receive dual runtime shebang support (previously only bin/ directory files were processed)
- All executable files now have consistent dual runtime behavior regardless of directory location

## [0.1.12] - 2025-01-14

### Added
- **Dual runtime support** for bin entries with intelligent bun/node detection based on package manager context
- **Top-level await (TLA) support** with graceful CJS fallback - automatically disables CJS generation when TLA is detected
- **bin/ directory support** for executable entrypoints alongside src/ entries
- Respect `engines.bun` field for runtime preferences in dual runtime detection
- Automatic shebang replacement with shell script wrapper for maximum compatibility

### Changed
- **Single-batch ESM build** - combined src/ and bin/ builds for better performance
- **Smart externalization** - entry points are externalized, nested files are bundled to prevent code duplication
- TypeScript declarations now conditional on tsc availability (no failures in environments without TypeScript)

### Fixed
- Fix TypeScript declaration generation for bin entries
- Fix CLI argument parsing for directory paths with npm flags
- Fix externalization to only apply to entry points, not nested utility files

## [0.1.11] - 2025-11-02

### Fixed
- **CRITICAL**: Workspace dependencies (workspace:*) are now properly resolved to actual version numbers during build
- Validation warnings for valid libuild output paths (dist/src/ files that libuild creates)

## [0.1.10] - 2025-10-29

### Added
- Automatic cleanup of invalid bin/exports paths when using --save flag
- Clear messaging that libuild is zero-config with NO libuild.config.js file

### Fixed
- --save now validates and removes bin/exports entries pointing to non-existent files
- Package.json fields are regenerated based on actual built files during --save
- Validation logic is now context-aware of --save flag to prevent warnings about configuration that libuild itself creates
- CLI argument parsing to prevent npm flags from being incorrectly treated as directory arguments

## [0.1.9] - 2025-10-29

### Fixed
- Preserve import attributes (`with { type: "json" }`) in externalized JSON imports to prevent Node.js runtime errors
- Upgrade Node.js target to 18+ and engines requirement to >=18.20.0 for import attributes support

## [0.1.8] - 2025-10-29

### Added
- Directory argument support for CLI commands - can now run `libuild build /path/to/project`

### Fixed  
- Eliminated unnecessary CommonJS helpers (`__commonJS`, `__require`) in ESM output by externalizing JSON imports
- Simplified externalization strategy using `packages: "external"` for cleaner Node.js CLI builds

## [0.1.7] - 2025-10-28

### Added
- Auto-ignore patterns for common test file conventions
  - Automatically ignores `*.test.*` files (Jest/Vitest standard)
  - Automatically ignores `*.spec.*` files (Jasmine/Angular standard)
  - Automatically ignores `__tests__/` directories (Facebook/React standard)
  - Automatically ignores `test/` directories (simple test directory standard)