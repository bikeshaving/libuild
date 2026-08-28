/**
 * In-source tests: strip the `import.meta.litest` guard block from library
 * builds.
 *
 * Tests written next to the code they cover (Rust's `mod tests`, Vitest's
 * in-source testing) share the module's closure, so they can reach private
 * state that was never exported. The cost is that the test block must not
 * reach the published package - neither the assertions nor, worse, an import
 * of the test framework, which would make every consumer install libuild to
 * run the library.
 *
 * Nothing is imported, so there is no import to leak: the runner injects the
 * test API AS `import.meta.litest` (see `bundleTests`). Here, on the library
 * side, that property is defined as `undefined` and the now-constant `if` is
 * folded away.
 *
 * Folding needs `minifySyntax`, which libuild does not want on the whole build
 * - the readable, unminified output is the point. So it runs per FILE, and
 * only on files that actually contain the marker: a package that never writes
 * an in-source test gets byte-identical output to before, and one that does
 * pays the syntax rewrite (`if`/`continue` becomes `||`, and so on) only in
 * the files it opted in.
 *
 * The alternative - rewriting the guard to a labeled block so esbuild's
 * `dropLabels` removes it at parse time with no minification - was rejected:
 * `dropLabels` deletes ANY statement carrying that label, so a consumer who
 * happens to label a loop with the same name loses the loop, silently, with no
 * warning and a successful build. Uglier output is a better failure than a
 * miscompile.
 */

import * as ESBuild from "esbuild";
import * as FS from "fs/promises";
import * as Path from "path";

/**
 * The marker. A plain substring scan of the source decides whether a file has
 * in-source tests - the same rule the test runner discovers them by, and the
 * same rule Vitest uses, so a file mentioning it in a comment counts too.
 * Over-matching is harmless (the transform is a no-op on a file with no real
 * guard); under-matching would ship a test block.
 *
 * Assembled from parts rather than written out, so the modules that IMPLEMENT
 * in-source tests don't match their own scan and get discovered as test files.
 * Every other reference goes through this constant, as a computed key where a
 * literal would otherwise reintroduce it.
 */
export const LITEST_PROPERTY = "litest";
export const LITEST_MARKER = `import.meta.${LITEST_PROPERTY}`;

/**
 * The canonical guard, and what test DISCOVERY matches - deliberately stricter
 * than the marker above.
 *
 * The two rules differ on purpose, and the asymmetry is the safe direction.
 * Stripping is permissive: any file mentioning the marker is transformed, and
 * because the define folds whatever expression the guard turns out to be, no
 * spelling of it can survive into a library build. Discovery is strict: only a
 * real guard makes a file a test file, so a module that merely writes about
 * `import.meta.litest` in a comment - like this one - is not bundled and run as
 * a test. Getting that wrong is not cosmetic; it would pull this file, esbuild
 * and all, into a browser test bundle.
 */
export const LITEST_GUARD = new RegExp(
  String.raw`if\s*\(\s*import\.meta\.${LITEST_PROPERTY}\s*\)`
);

const SOURCE_FILES = /\.(ts|tsx|mts|js|jsx|mjs)$/;

function loaderFor(path: string): ESBuild.Loader {
  const ext = Path.extname(path).toLowerCase();
  return ext === ".ts" || ext === ".mts" ? "ts"
    : ext === ".tsx" ? "tsx"
    : ext === ".jsx" ? "jsx"
    : "js";
}

/**
 * `jsx: "preserve"` keeps JSX intact through the transform so the surrounding
 * build stays the one authority on how JSX compiles - baking in esbuild's
 * default here would silently override a package's own JSX settings for the
 * one file that happens to contain a test.
 */
export function litestStripPlugin(): ESBuild.Plugin {
  return {
    name: "libuild-litest-strip",
    setup(build) {
      build.onLoad({ filter: SOURCE_FILES }, async (args) => {
        const contents = await FS.readFile(args.path, "utf-8");
        if (!contents.includes(LITEST_MARKER)) return undefined; // load natively
        const loader = loaderFor(args.path);
        const stripped = await ESBuild.transform(contents, {
          loader,
          jsx: "preserve",
          minifySyntax: true,
          define: { [LITEST_MARKER]: "undefined" },
          sourcefile: args.path,
        });
        return {
          contents: stripped.code,
          loader,
          resolveDir: Path.dirname(args.path),
        };
      });
    },
  };
}
