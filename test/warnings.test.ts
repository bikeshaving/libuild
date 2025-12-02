import {test, expect} from "bun:test";
import * as FS from "fs/promises";
import * as Path from "path";
import {build} from "../src/libuild.ts";
import {createTempDir, removeTempDir, copyFixture, readJSON} from "./test-utils.ts";

test("warns when package.json lacks publish protection", async () => {
  const testDir = await createTempDir("warn-publish-guard");

  // Copy fixture and remove publish protection
  await copyFixture("simple-lib", testDir);

  const pkg = await readJSON(Path.join(testDir, "package.json"));
  pkg.private = false;
  delete pkg.scripts?.prepublishOnly;
  await FS.writeFile(Path.join(testDir, "package.json"), JSON.stringify(pkg, null, 2));

  // Capture console output
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    await build(testDir);

    // Should have warned about missing publish protection
    expect(warnings.some(w => w.includes("lacks publish protection"))).toBe(true);
  } finally {
    console.warn = originalWarn;
    await removeTempDir(testDir);
  }
});

test("warns when dist/ is not in .gitignore", async () => {
  const testDir = await createTempDir("warn-gitignore");

  // Copy fixture
  await copyFixture("simple-lib", testDir);

  // Create .gitignore without dist/
  await FS.writeFile(Path.join(testDir, ".gitignore"), "node_modules/\n*.log\n");

  // Capture console output
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    await build(testDir);

    // Should have warned about missing dist/ in gitignore
    expect(warnings.some(w => w.includes("dist/ directory is not in .gitignore"))).toBe(true);
  } finally {
    console.warn = originalWarn;
    await removeTempDir(testDir);
  }
});

test("no gitignore warning when dist/ is properly ignored", async () => {
  const testDir = await createTempDir("good-gitignore");

  // Copy fixture
  await copyFixture("simple-lib", testDir);

  // Create proper .gitignore with dist/
  await FS.writeFile(Path.join(testDir, ".gitignore"), "node_modules/\ndist/\n*.log\n");

  // Capture console output
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    await build(testDir);

    // Should NOT have warned about gitignore
    expect(warnings.some(w => w.includes("dist/ directory is not in .gitignore"))).toBe(false);
  } finally {
    console.warn = originalWarn;
    await removeTempDir(testDir);
  }
});

test("detects various dist/ gitignore patterns", async () => {
  const testDir = await createTempDir("gitignore-patterns");

  // Copy fixture
  await copyFixture("simple-lib", testDir);

  const patterns = [
    "dist/",
    "/dist",
    "dist\n",
    "dist\r\n"
  ];

  for (const pattern of patterns) {
    // Create .gitignore with the pattern
    await FS.writeFile(Path.join(testDir, ".gitignore"), `node_modules/\n${pattern}*.log\n`);

    // Capture console output
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      await build(testDir);

      // Should NOT warn for any of these patterns
      expect(warnings.some(w => w.includes("dist/ directory is not in .gitignore"))).toBe(false);
    } finally {
      console.warn = originalWarn;
    }
  }

  await removeTempDir(testDir);
});
