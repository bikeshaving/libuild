#!/usr/bin/env node
import { Command } from "commander";
import * as FS from "fs/promises";
import * as Path from "path";
import { build, publish, stage } from "./libuild.ts";
import { resolveTestTargets, runTests, type Platform } from "./internal/test-runner.ts";

// =============================================================================
// Publish argument validation
// =============================================================================
// The publish command forwards flags to `npm publish`, so its arguments are
// validated against a strict whitelist to prevent command injection and
// unsafe npm behavior (e.g. --ignore-scripts, --script-shell, --unsafe-perm).
// Unknown flags and unexpected positional arguments are dropped with a
// warning instead of being forwarded to npm.

const ALLOWED_NPM_FLAGS = new Set([
  "--dry-run", "--tag", "--access", "--registry", "--otp", "--provenance",
  "--workspace", "--workspaces", "--include-workspace-root",
]);

// Allowed flags that consume a following value (when not written as --flag=value)
const NPM_VALUE_FLAGS = new Set([
  "--tag", "--access", "--registry", "--otp", "--workspace",
]);

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stat = await FS.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function runPublish(argv: string[], command: "publish" | "stage" = "publish"): Promise<void> {
  // Remove the command token (first occurrence only)
  const args = [...argv];
  args.splice(args.indexOf(command), 1);

  let save = true;
  let directory: string | undefined;
  const extraArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // libuild-level flags (not forwarded to npm)
    if (arg === "--save") {
      save = true;
      continue;
    }
    if (arg === "--no-save") {
      save = false;
      continue;
    }

    if (arg.startsWith("-")) {
      const flagName = arg.split("=")[0]; // Handle --flag=value format
      if (ALLOWED_NPM_FLAGS.has(flagName)) {
        extraArgs.push(arg);
        // If this flag expects a value and it's not --flag=value, consume the next argument
        if (!arg.includes("=") && NPM_VALUE_FLAGS.has(flagName) &&
            i + 1 < args.length && !args[i + 1].startsWith("-")) {
          extraArgs.push(args[i + 1]);
          i++;
        }
      } else {
        console.warn(`Warning: Ignoring unknown/unsafe npm flag: ${arg}`);
      }
      continue;
    }

    // Non-flag argument: either the target directory or unexpected
    if (directory === undefined && await isDirectory(Path.resolve(arg))) {
      directory = arg;
    } else {
      console.warn(`Warning: Ignoring unexpected argument: ${arg}`);
    }
  }

  const cwd = Path.resolve(directory ?? ".");
  try {
    await (command === "stage" ? stage : publish)(cwd, save, extraArgs);
  } catch (error: any) {
    console.error("Error:", error?.message ?? error);
    process.exit(1);
  }
}

const program = new Command();

program
  .name("libuild")
  .description("Zero-config library builds")
  .version("0.1.22");

program
  .command("build", { isDefault: true })
  .description("Build the library")
  .argument("[directory]", "Directory to build", ".")
  .option("--save", "Update root package.json to point to dist files")
  .action(async (directory: string, options: { save?: boolean }) => {
    const cwd = Path.resolve(directory);
    try {
      await build(cwd, options.save || false);
    } catch (error: any) {
      // A refusal or build failure is a clean one-line error and exit 1,
      // never an unhandled-rejection stack dump.
      console.error("Error:", error?.message ?? error);
      process.exit(1);
    }
  });

program
  .command("publish")
  .description("Build and publish the library")
  .argument("[directory]", "Directory to build and publish", ".")
  .option("--no-save", "Skip package.json updates")
  .option("--dry-run", "Perform a dry run")
  .option("--tag <tag>", "Publish with a specific tag")
  .option("--access <access>", "Set access level (public/restricted)")
  .option("--registry <url>", "Use a specific registry")
  .option("--otp <code>", "One-time password for 2FA")
  .option("--provenance", "Generate provenance statement")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    // Publish uses whitelist-validated manual parsing (see runPublish) so
    // unknown/unsafe npm flags are filtered with warnings instead of erroring.
    await runPublish(process.argv.slice(2));
  });

program
  .command("stage")
  .description("Build and stage on npm (uploaded but not installable until 'npm stage approve')")
  .argument("[directory]", "Directory to build and stage", ".")
  .option("--no-save", "Skip package.json updates")
  .option("--dry-run", "Perform a dry run")
  .option("--tag <tag>", "Stage with a specific dist-tag")
  .option("--registry <url>", "Use a specific registry")
  .option("--provenance", "Generate provenance statement")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    // Same whitelist-validated manual parsing as publish (see dispatch below).
    await runPublish(process.argv.slice(2), "stage");
  });

program
  .command("test")
  .description("Run tests across platforms")
  .argument("[targets...]", "Directory containing tests, or specific test file(s)/glob(s) to run")
  .option("-p, --platform <platforms...>", "Platforms to test on (bun, node, chromium, firefox, webkit)")
  .option("--debug", "Keep browser open for debugging")
  .option("--filter <patterns...>", "Glob pattern(s) selecting which test files to run")
  .option("--timeout <ms>", "Per-file test timeout in milliseconds", "60000")
  .option("-u, --update-snapshots", "Write/update snapshot files instead of comparing")
  .action(async (targets: string[], options: {
    platform?: string[];
    debug?: boolean;
    filter?: string[];
    timeout?: string;
    updateSnapshots?: boolean;
  }) => {
    // A target may be a directory (the root), specific test files, or an
    // unexpanded glob - so the single-file loop runs under the same loader,
    // setup file, and platforms as the full suite (issue #19).
    let cwd: string;
    let files: string[];
    let patterns: string[] | undefined;
    try {
      const resolved = await resolveTestTargets(process.cwd(), targets ?? []);
      cwd = resolved.cwd;
      files = resolved.files;
      patterns = options.filter ?? (resolved.patterns.length ? resolved.patterns : undefined);
    } catch (error: any) {
      console.error("Error:", error?.message ?? error);
      process.exit(1);
    }

    // Validate platforms
    const validPlatforms: Platform[] = ["bun", "node", "chromium", "firefox", "webkit"];
    const platforms: Platform[] = options.platform?.length
      ? options.platform.filter((p): p is Platform => validPlatforms.includes(p as Platform))
      : ["bun"];

    if (options.platform?.length && platforms.length !== options.platform.length) {
      const invalid = options.platform.filter(p => !validPlatforms.includes(p as Platform));
      console.error(`Invalid platform(s): ${invalid.join(", ")}`);
      console.error(`Valid platforms: ${validPlatforms.join(", ")}`);
      process.exit(1);
    }

    const success = await runTests({
      cwd,
      files,
      patterns,
      platforms,
      debug: options.debug || false,
      timeout: parseInt(options.timeout || "60000", 10),
      updateSnapshots: options.updateSnapshots || false,
    });

    process.exit(success ? 0 : 1);
  });

// Dispatch: the publish and stage commands bypass commander's strict parsing so that
// unknown/unsafe npm flags, stray arguments, and libuild flags in any position
// (e.g. `libuild --save publish ...`) are handled by the whitelist validation
// in runPublish. Everything else (build, test, help, version) uses commander.
// stage shares publish's parser: same whitelist, different npm subcommand.
const cliArgs = process.argv.slice(2);
const commandToken = cliArgs.find((arg) => !arg.startsWith("-"));

if ((commandToken === "publish" || commandToken === "stage") && !cliArgs.includes("--help") && !cliArgs.includes("-h")) {
  runPublish(cliArgs, commandToken).catch((error: any) => {
    console.error("Error:", error?.message ?? error);
    process.exit(1);
  });
} else {
  program.parse();
}
