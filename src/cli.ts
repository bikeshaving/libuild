#!/usr/bin/env node
import { Command } from "commander";
import * as Path from "path";
import { build, publish } from "./libuild.ts";
import { runTests, type Platform } from "./test-runner.ts";

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
    await build(cwd, options.save || false);
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
  .action(async (directory: string, options: Record<string, any>) => {
    const cwd = Path.resolve(directory);
    const shouldSave = options.save !== false;

    // Build npm publish args from options
    const npmArgs: string[] = [];
    if (options.dryRun) npmArgs.push("--dry-run");
    if (options.tag) npmArgs.push("--tag", options.tag);
    if (options.access) npmArgs.push("--access", options.access);
    if (options.registry) npmArgs.push("--registry", options.registry);
    if (options.otp) npmArgs.push("--otp", options.otp);
    if (options.provenance) npmArgs.push("--provenance");

    await publish(cwd, shouldSave, npmArgs);
  });

program
  .command("test")
  .description("Run tests across platforms")
  .argument("[directory]", "Directory containing tests", ".")
  .option("-p, --platform <platforms...>", "Platforms to test on (bun, node, chromium, firefox, webkit)")
  .option("--debug", "Keep browser open for debugging")
  .option("-w, --watch", "Watch mode - re-run tests on file changes")
  .option("--timeout <ms>", "Test timeout in milliseconds", "60000")
  .action(async (directory: string, options: {
    platform?: string[];
    debug?: boolean;
    watch?: boolean;
    timeout?: string;
  }) => {
    const cwd = Path.resolve(directory);

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
      platforms,
      debug: options.debug || false,
      watch: options.watch || false,
      timeout: parseInt(options.timeout || "60000", 10),
    });

    process.exit(success ? 0 : 1);
  });

program.parse();
