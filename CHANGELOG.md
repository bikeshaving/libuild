# Changelog

All notable changes to this project will be documented in this file.

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