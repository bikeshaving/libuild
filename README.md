# libuild

Zero-config library builds with ESBuild.

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

- **Zero configuration** - Works out of the box
- **Structure-preserving builds** - Maintains src/ directory structure in dist/
- **Multiple formats** - ESM, CommonJS, and TypeScript declarations
- **Universal compatibility** - No runtime requirements (Node.js, Bun, Deno)
- **Smart entry detection** - Automatically finds all library entry points
- **Development-friendly** - Optional --save flag prevents git noise during development
- **Perfect npm link** - Works from both project root and dist directory
- **UMD builds** - Optional browser-compatible builds
- **Clean output** - Optimized package.json for consumers

## Conventions

### Entry Points
- **Library modules**: All top-level `.ts`/`.js` files in `src/` (excluding `_` prefixed files)
- **CLI binaries**: Any file referenced in `package.json` `bin` field gets compiled to standalone executable
- **UMD builds**: If `src/umd.ts` exists, creates browser-compatible UMD build

### Output Structure
- **Structure-preserving**: `src/index.ts` → `dist/src/index.js` (maintains src/ directory)
- **ESM**: `.js` files with ES module syntax
- **CommonJS**: `.cjs` files for Node.js compatibility
- **TypeScript**: `.d.ts` declaration files (when TypeScript is available)
- **Clean package.json**: Optimized for consumers (no dev scripts)

### Format Control
- **ESM-only**: Remove the `main` field from package.json to skip CommonJS builds
- **CommonJS detection**: Presence of `main` field enables `.cjs` builds
- **UMD builds**: Add `src/umd.ts` for browser-compatible builds

### Export Aliases
- **Legacy support**: `./index.js` automatically aliases to `./index`
- **JSX runtime**: `src/jsx-runtime.ts` auto-creates `./jsx-dev-runtime` alias
- **Package.json**: Always exported as `./package.json`
- **Custom exports**: Existing exports in package.json are preserved and enhanced

### Package.json Transformations
- **Development mode** (default): Root package.json unchanged, no git noise
- **--save mode**: Root package.json updated to point to `./dist/src/*` artifacts for npm link
- **Dist package.json**: Clean consumer-ready version with relative `src/` paths
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
  src/
    index.js       # ESM
    index.cjs      # CommonJS
    index.d.ts     # TypeScript declarations
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
  src/
    index.js
    index.cjs
    index.d.ts
    cli.js         # Compiled CLI
    cli.cjs
    cli.d.ts
  package.json     # bin: { "mytool": "./src/cli.js" }
```

### ESM-Only Library

To build only ESM (no CommonJS), remove the `main` field:

```json
// package.json
{
  "name": "my-lib",
  "module": "dist/src/index.js",  // ESM entry
  "types": "dist/src/index.d.ts"
  // no "main" field = no CJS
}
```

Produces:
```
dist/
  src/
    index.js       # ESM only
    index.d.ts
    utils.js       # ESM only
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
  src/
    index.js
    index.cjs
    index.d.ts
    utils.js
    utils.cjs
    utils.d.ts
    umd.js         # UMD browser build
  package.json
```

### Generated Package.json Exports

**Dual format** (ESM + CommonJS):
```json
{
  "main": "src/index.cjs",
  "module": "src/index.js",
  "types": "src/index.d.ts",
  "exports": {
    ".": {
      "types": "./src/index.d.ts",
      "import": "./src/index.js",
      "require": "./src/index.cjs"
    },
    "./utils": {
      "types": "./src/utils.d.ts",
      "import": "./src/utils.js",
      "require": "./src/utils.cjs"
    },
    "./utils.js": {
      "types": "./src/utils.d.ts",
      "import": "./src/utils.js",
      "require": "./src/utils.cjs"
    },
    "./package.json": "./package.json"
  }
}
```

**ESM-only** (no `main` field in source):
```json
{
  "module": "src/index.js",
  "types": "src/index.d.ts",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.d.ts",
      "import": "./src/index.js"
    },
    "./utils": {
      "types": "./src/utils.d.ts",
      "import": "./src/utils.js"
    },
    "./utils.js": {
      "types": "./src/utils.d.ts",
      "import": "./src/utils.js"
    },
    "./package.json": "./package.json"
  }
}
```

**Root package.json** (with --save):
```json
{
  "main": "./dist/src/index.cjs",
  "module": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/src/index.d.ts",
      "import": "./dist/src/index.js",
      "require": "./dist/src/index.cjs"
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

- **Node.js 16+** or **Bun 1.0+** (for running libuild)
- **TypeScript** (optional, for .d.ts generation)
- No runtime requirements for library consumers

## License

MIT
