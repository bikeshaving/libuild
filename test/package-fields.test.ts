import { test, expect } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import { build } from "../src/libuild.ts";
import { createTempDir, removeTempDir, copyFixture, readJson, fileExists } from "./test-utils.ts";

test("handles comprehensive package.json fields", async () => {
  const testDir = await createTempDir("comprehensive-fields");
  
  // Copy fixture
  await copyFixture("simple-lib", testDir);
  
  // Create docs directory and files for the files field pattern
  await fs.mkdir(path.join(testDir, "docs"), { recursive: true });
  await fs.writeFile(path.join(testDir, "docs", "api.md"), "# API Documentation");
  await fs.writeFile(path.join(testDir, "docs", "guide.md"), "# User Guide");
  
  // Create comprehensive package.json
  const comprehensivePkg = {
    name: "comprehensive-test",
    version: "1.0.0",
    description: "A comprehensive test package",
    keywords: ["test", "library"],
    author: "Test Author <test@example.com>",
    contributors: ["Contributor 1", "Contributor 2"],
    maintainers: ["Maintainer 1"],
    license: "MIT",
    repository: {
      type: "git",
      url: "https://github.com/test/comprehensive.git"
    },
    bugs: {
      url: "https://github.com/test/comprehensive/issues"
    },
    homepage: "https://github.com/test/comprehensive",
    funding: {
      type: "github",
      url: "https://github.com/sponsors/testuser"
    },
    private: true,
    type: "module",
    main: "src/index.js",
    dependencies: {
      "lodash": "^4.17.21"
    },
    peerDependencies: {
      "react": ">=16.0.0"
    },
    optionalDependencies: {
      "optional-dep": "^1.0.0"
    },
    bundledDependencies: ["bundled-dep"],
    engines: {
      node: ">=16.0.0"
    },
    cpu: ["x64"],
    os: ["linux", "darwin"],
    sideEffects: false,
    browserslist: ["> 1%", "last 2 versions"],
    files: ["src/**/*", "docs/*.md"]
  };
  
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify(comprehensivePkg, null, 2));
  
  // Build
  await build(testDir);
  
  const distDir = path.join(testDir, "dist");
  const distPkg = await readJson(path.join(distDir, "package.json"));
  
  // Check that all fields are preserved
  expect(distPkg.description).toBe("A comprehensive test package");
  expect(distPkg.keywords).toEqual(["test", "library"]);
  expect(distPkg.author).toBe("Test Author <test@example.com>");
  expect(distPkg.contributors).toEqual(["Contributor 1", "Contributor 2"]);
  expect(distPkg.maintainers).toEqual(["Maintainer 1"]);
  expect(distPkg.license).toBe("MIT");
  expect(distPkg.repository).toEqual({
    type: "git",
    url: "https://github.com/test/comprehensive.git"
  });
  expect(distPkg.bugs).toEqual({
    url: "https://github.com/test/comprehensive/issues"
  });
  expect(distPkg.homepage).toBe("https://github.com/test/comprehensive");
  expect(distPkg.funding).toEqual({
    type: "github",
    url: "https://github.com/sponsors/testuser"
  });
  
  // Runtime fields
  expect(distPkg.dependencies).toEqual({"lodash": "^4.17.21"});
  expect(distPkg.peerDependencies).toEqual({"react": ">=16.0.0"});
  expect(distPkg.optionalDependencies).toEqual({"optional-dep": "^1.0.0"});
  expect(distPkg.bundledDependencies).toEqual(["bundled-dep"]);
  expect(distPkg.engines).toEqual({node: ">=16.0.0"});
  expect(distPkg.cpu).toEqual(["x64"]);
  expect(distPkg.os).toEqual(["linux", "darwin"]);
  expect(distPkg.sideEffects).toBe(false);
  expect(distPkg.browserslist).toEqual(["> 1%", "last 2 versions"]);
  
  // typings field is legacy and not preserved (use types instead)
  
  // Check files field transformation
  expect(distPkg.files).toEqual(["./src/**/*", "docs/*.md"]);
  
  // Check that scripts are excluded
  expect(distPkg.scripts).toBeUndefined();
  
  // Cleanup
  await removeTempDir(testDir);
});

test("npm lifecycle scripts are preserved", async () => {
  const testDir = await createTempDir("lifecycle-scripts-test");
  
  // Create package.json with mix of scripts
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "lifecycle-scripts-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    scripts: {
      "postinstall": "echo 'after install'", // should be kept
      "preinstall": "echo 'before install'", // should be kept
      "build": "echo 'build script'", // should be removed
      "test": "echo 'test script'" // should be removed
    }
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await build(testDir, false);
  
  const distPkg = await readJson(path.join(testDir, "dist", "package.json"));
  
  // Should only have lifecycle scripts
  expect(distPkg.scripts).toEqual({
    "postinstall": "echo 'after install'",
    "preinstall": "echo 'before install'"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("file copy error: pattern with non-existent base directory", async () => {
  const testDir = await createTempDir("copy-error-test");
  
  // Create package.json with files pattern that has non-existent base
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "copy-error-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: ["nonexistent/*.md"] // Pattern with non-existent base directory
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await expect(build(testDir, false)).rejects.toThrow('Pattern base directory not found for "nonexistent/*.md"');
  
  // Cleanup
  await removeTempDir(testDir);
});

test("file copy error: missing file in files field", async () => {
  const testDir = await createTempDir("missing-file-test");
  
  // Create package.json with files field containing non-existent file
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "missing-file-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: ["MISSING.md"] // File that doesn't exist
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await expect(build(testDir, false)).rejects.toThrow('File specified in files field not found');
  
  // Cleanup
  await removeTempDir(testDir);
});

test("files field with invalid entry type", async () => {
  const testDir = await createTempDir("invalid-files-test");
  
  // Create package.json with invalid files field entry
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "invalid-files-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    type: "module",
    private: true,
    files: [123] // Invalid non-string entry
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), { recursive: true });
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  
  await expect(build(testDir, false)).rejects.toThrow("Invalid files field entry: 123. Files field entries must be strings.");
  
  // Cleanup
  await removeTempDir(testDir);
});

