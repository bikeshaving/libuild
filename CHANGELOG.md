# Changelog

All notable changes to this project will be documented in this file.

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