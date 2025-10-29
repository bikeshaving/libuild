# Changelog

All notable changes to this project will be documented in this file.

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