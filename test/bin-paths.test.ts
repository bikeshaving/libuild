import {test, expect} from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON, fileExists} from "./test-utils.ts";

test("bin paths follow npm conventions (no ./ prefix)", async () => {
  const testDir = await createTempDir("bin-paths-test");
  
  // Create package.json with bin field
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "bin-paths-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    bin: {
      mytool: "./dist/src/cli.js"
    },
    type: "module",
    private: true
  }));
  
  // Create src directory with CLI entry
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "cli.ts"), '#!/usr/bin/env node\nexport const cli = "tool";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  
  // Dist package.json should have bin path without ./ prefix
  expect(distPkg.bin).toEqual({
    mytool: "src/cli.js"
  });
  
  // Verify the CLI file actually exists
  expect(await fileExists(path.join(testDir, "dist", "src", "cli.js"))).toBe(true);
  
  // Cleanup
  await removeTempDir(testDir);
});

test("bin paths work correctly in --save mode (no double dist/ prefix)", async () => {
  const testDir = await createTempDir("bin-save-mode");
  
  // Create package.json with bin field
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "bin-save-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    bin: {
      mytool: "./dist/src/cli.js"
    },
    type: "module",
    private: true
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "cli.ts"), '#!/usr/bin/env node\nexport const cli = "tool";');
  
  await build(testDir, true); // --save mode
  
  // Check root package.json
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  
  // Should NOT have double dist/ prefix
  expect(rootPkg.bin).toEqual({
    mytool: "./dist/src/cli.js"
  });
  
  // Check dist package.json
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  
  // Should have correct relative path without ./ prefix
  expect(distPkg.bin).toEqual({
    mytool: "src/cli.js"
  });
  
  // Cleanup
  await removeTempDir(testDir);
});

test("bin paths with multiple binaries work correctly", async () => {
  const testDir = await createTempDir("multiple-bins");
  
  // Create package.json with multiple bin entries
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "multiple-bins-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    bin: {
      tool1: "./dist/src/cli1.js",
      tool2: "./dist/src/cli2.js"
    },
    type: "module",
    private: true
  }));
  
  // Create src directory with multiple CLI entries
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "cli1.ts"), '#!/usr/bin/env node\nexport const cli1 = "tool1";');
  await fs.writeFile(path.join(testDir, "src", "cli2.ts"), '#!/usr/bin/env node\nexport const cli2 = "tool2";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  
  // All bin paths should be correct
  expect(distPkg.bin).toEqual({
    tool1: "src/cli1.js",
    tool2: "src/cli2.js"
  });
  
  // Verify all CLI files exist
  expect(await fileExists(path.join(testDir, "dist", "src", "cli1.js"))).toBe(true);
  expect(await fileExists(path.join(testDir, "dist", "src", "cli2.js"))).toBe(true);
  
  // Cleanup
  await removeTempDir(testDir);
});

test("bin paths handle string format (single binary)", async () => {
  const testDir = await createTempDir("string-bin");
  
  // Create package.json with string bin field
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "string-bin-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    bin: "./dist/src/cli.js", // String format instead of object
    type: "module",
    private: true
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "cli.ts"), '#!/usr/bin/env node\nexport const cli = "tool";');
  
  await build(testDir, false);
  
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  
  // String bin should be transformed correctly
  expect(distPkg.bin).toBe("src/cli.js");
  
  // Cleanup
  await removeTempDir(testDir);
});

test("bin paths work in --save mode with string format", async () => {
  const testDir = await createTempDir("string-bin-save");
  
  // Create package.json with string bin field
  await fs.writeFile(path.join(testDir, "package.json"), JSON.stringify({
    name: "string-bin-save-test",
    version: "1.0.0",
    main: "dist/index.cjs",
    bin: "./dist/src/cli.js",
    type: "module",
    private: true
  }));
  
  // Create src directory
  await fs.mkdir(path.join(testDir, "src"), {recursive: true});
  await fs.writeFile(path.join(testDir, "src", "index.ts"), 'export const index = "main";');
  await fs.writeFile(path.join(testDir, "src", "cli.ts"), '#!/usr/bin/env node\nexport const cli = "tool";');
  
  await build(testDir, true); // --save mode
  
  // Check root package.json
  const rootPkg = await readJSON(path.join(testDir, "package.json"));
  expect(rootPkg.bin).toBe("./dist/src/cli.js");
  
  // Check dist package.json
  const distPkg = await readJSON(path.join(testDir, "dist", "package.json"));
  expect(distPkg.bin).toBe("src/cli.js");
  
  // Cleanup
  await removeTempDir(testDir);
});