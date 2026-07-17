# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-07-17

### Changed
- **Flat output layout** - Modules now publish at the package root (`<pkg>/index.js`) instead of nested under `src/` (`<pkg>/src/index.js`). Direct CDN file URLs (jsDelivr, unpkg) serve literal paths and do not consult the exports map, so the old layout 404'd copy-paste URLs like `cdn.jsdelivr.net/npm/<pkg>/index.js`. Executables stay under `bin/`, code-splitting chunks move to `_chunks/` (was `src/_chunks/`). Fixes [#9](https://github.com/bikeshaving/libuild/issues/9).
- **Compatibility stubs** - `dist/src/` now contains tiny re-export shims (plus a full UMD copy) so `<pkg>/src/<entry>.js` paths from packages published with older libuild versions keep resolving - old CDN URLs and literal deep imports do not break. Node consumers are unaffected either way: exports-map keys never contained `src/`.
- **`--save` paths** - Root package.json now points at `./dist/<entry>.*` (was `./dist/src/<entry>.*`). Old saved paths are migrated automatically on the next `--save` run.

### Fixed
- **UMD build corrupted sibling entries** - The UMD wrapper was applied to every `.js` file in the output directory, silently wrapping (and breaking) other entry modules in packages with a `src/umd.ts`. It now wraps only the UMD output file.
- **`--save` bin pointed at non-executables** - Bin paths that resolve to a file that exists but is not the built executable are now normalized to the real artifact.

### Notes
- Deep links to *internal* files of previously published packages (e.g. `<pkg>/src/plugins/x.d.ts`) are not stubbed - only entry points are. Internal paths were never part of the public contract.

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