# libuild

Zero-config library builds with ESBuild.

Libuild is a build tool for JavaScript/TypeScript libraries which publish to
NPM. It solves ESM/CJS support, type generation, and produces clean packages
with just the files and configuration needed by consumers.

## Installation

```bash
npm install -D @b9g/libuild
bun add -d @b9g/libuild
```

## Usage

```bash
# Build your library (development mode - no package.json changes)
libuild build

# Build and update package.json for npm link
libuild build --save

# Build and publish to npm
libuild publish
```

## Features

- **No configuration** - Source files and standard package.json are all you need
- **Multiple formats** - Supports ESM, CJS, UMD, and generates d.ts files
- **Clean output** - Only necessary files and fields go into the package
- **Development-friendly** - NPM link just works and changes can be saved to package.json

## Convention = Configuration

### Entry Points
- **Library modules**: All top-level `.js`/`.ts` files in `src/` (excluding `_` prefixed files)
- **CLI binaries**: Any file referenced in `package.json` `bin` field gets compiled to standalone executable
- **UMD builds**: If `src/umd.ts` exists, creates browser-compatible UMD build

### Output Structure
- **Flat output**: `src/index.ts` → `dist/index.js` - modules publish at the package root, so direct CDN URLs like `cdn.jsdelivr.net/npm/<pkg>/index.js` just work
- **Executables**: `bin/cli.ts` → `dist/bin/cli.js` (bin/ stays a subdirectory)
- **ESM**: `.js` files with ES module syntax
- **CommonJS**: `.cjs` files for Node.js compatibility
- **TypeScript**: `.d.ts` declaration files for all modules (when TypeScript is available); internal modules relocate together with their imports intact
- **Module augmentation**: `declare module` blocks are preserved in .d.ts output
- **Code splitting**: Dynamic imports create chunks in `dist/_chunks/`
- **Clean package.json**: Optimized for consumers (no dev scripts)

### Format Control
- **ESM-only**: Remove the `main` field from package.json to skip CommonJS builds
- **CommonJS detection**: Presence of `main` field enables `.cjs` builds
- **UMD builds**: Add `src/umd.ts` for browser-compatible builds

### Export Aliases
- **Legacy support**: `./entry.js` automatically aliases to `./entry`
- **Package.json**: Always exported as `./package.json`
- **Custom exports**: Existing exports in package.json are preserved and enhanced

### Package.json Transformations
- **Development mode** (default): Root package.json unchanged, no git noise
- **--save mode**: Root package.json updated to point to `./dist/*` artifacts for npm link
- **Dist package.json**: Clean consumer-ready version with root-relative paths
- **Bin paths**: Automatically transformed from `src/` references to built artifacts
- **Exports field**: Generated for all entry points with proper types-first ordering

## Examples

### Simple Library

Given this structure:
```
src/
  index.ts
  utils.ts
  _internal.ts  # ignored (underscore prefix)
```

Produces:
```
dist/
  index.js         # ESM
  index.cjs        # CommonJS
  index.d.ts       # TypeScript declarations
  utils.js
  utils.cjs
  utils.d.ts
  package.json     # Clean consumer version
```

### Library with CLI

```
package.json:
{
  "bin": { "mytool": "src/cli.js" }
}

src/
  index.ts
  cli.ts
```

Produces:
```
dist/
  index.js
  index.cjs
  index.d.ts
  cli.js           # Compiled CLI (dual-runtime shebang, executable)
  cli.cjs
  cli.d.ts
  package.json     # bin: { "mytool": "cli.js" }
```

### ESM-Only Library

To build only ESM (no CommonJS), remove the `main` field:

```json
// package.json
{
  "name": "my-lib",
  "module": "dist/index.js",  // ESM entry
  "types": "dist/index.d.ts"
  // no "main" field = no CJS
}
```

Produces:
```
dist/
  index.js         # ESM only
  index.d.ts
  utils.js         # ESM only
  utils.d.ts
  package.json     # ESM-only exports
```

### Multi-Format with UMD

```
src/
  index.ts
  utils.ts
  umd.ts         # Browser build entry
```

Produces:
```
dist/
  index.js
  index.cjs
  index.d.ts
  utils.js
  utils.cjs
  utils.d.ts
  umd.js           # UMD browser build
  package.json
```

### Generated Package.json Exports

**Dual format** (ESM + CommonJS):
```json
{
  "main": "index.cjs",
  "module": "index.js",
  "types": "index.d.ts",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "import": "./index.js",
      "require": "./index.cjs"
    },
    "./utils": {
      "types": "./utils.d.ts",
      "import": "./utils.js",
      "require": "./utils.cjs"
    },
    "./utils.js": {
      "types": "./utils.d.ts",
      "import": "./utils.js",
      "require": "./utils.cjs"
    },
    "./package.json": "./package.json"
  }
}
```

**ESM-only** (no `main` field in source):
```json
{
  "module": "index.js",
  "types": "index.d.ts",
  "type": "module",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "import": "./index.js"
    },
    "./utils": {
      "types": "./utils.d.ts",
      "import": "./utils.js"
    },
    "./utils.js": {
      "types": "./utils.d.ts",
      "import": "./utils.js"
    },
    "./package.json": "./package.json"
  }
}
```

**Root package.json** (with --save):
```json
{
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

## Commands

### `libuild build` (default)
Builds your library in development mode:
- Compiles all entry points to multiple formats
- Generates TypeScript declarations
- Creates optimized package.json files
- Preserves root package.json (no git noise)

### `libuild build --save`
Builds and updates root package.json for npm link:
- Everything from `libuild build`
- Updates root package.json to point to dist artifacts
- Perfect for testing with `npm link`

### `libuild publish`
Builds and publishes to npm:
- Runs full build with --save
- Warns if root package.json is not private
- Publishes from dist directory with clean package.json

## Requirements

- **Node.js 20.10+** or **Bun 1.0+** (for running libuild)
- **TypeScript** (optional, for .d.ts generation)
- No runtime requirements for library consumers

## Testing: `libuild test`

Runs your suite across runtimes with one command and one set of test files:

```sh
libuild test                        # bun, current directory
libuild test tests -p bun -p node   # both runtimes
libuild test -p chromium            # real browser via Playwright
libuild test path/to/one.test.ts    # single-file loop
```

Import the portable API from `@b9g/libuild/test` (`describe`/`test`/`it`/`expect`, hooks, `test.concurrent`, `.each`, and a cross-runtime `toMatchSnapshot`). Files run in per-file isolated processes with dependencies resolved from your `node_modules`; `import.meta.url`/`.dirname`/`.filename` and `__dirname`/`__filename` point at your source files, not the bundles.

Flags: `--timeout <ms>` is the per-file budget, and on bun it is also applied as the per-test timeout (bun defaults to 5s per test; without this, slow tests die before the file budget matters). `--concurrency <n>` caps how many files run at once — lower it for suites whose tests spawn their own processes. `--filter <glob>` selects files; `-u` updates snapshots; `--debug` keeps the browser open and preserves the bundle directory.

Runtime notes:

- **bun cannot nest `test()` inside `test()`** (oven-sh/bun#5090). Notably, ESLint's `RuleTester` registers nested subtests, so rule suites hit `NotImplementedError` on bun — either run those with `-p node`, or flatten RuleTester's hooks (`RuleTester.describe = (_n, fn) => fn()` inside one enclosing test) to stay portable.
- libuild is ESM-only: packages declaring `"type": "commonjs"` are refused (packages with no `type` field are fine). CJS is produced only as the build's `main`-field fallback.

## License

MIT
