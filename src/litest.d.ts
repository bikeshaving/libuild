/**
 * Ambient type for in-source tests.
 *
 * `import.meta.litest` is the whole test API, injected by the runner and
 * `undefined` everywhere else - so the guard that reads it is also what makes
 * the block disappear from a library build. Optional, because outside a test
 * run it genuinely is absent; that is what narrows the block away for the type
 * checker exactly as it does for the bundler.
 *
 * `./test.js` resolves to `test.ts` in this repo and to `test.d.ts` in the
 * published package, so the type stays tied to the real module in both.
 */
interface ImportMeta {
  litest?: typeof import("./test.js");
}
