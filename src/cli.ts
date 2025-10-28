#!/usr/bin/env node
import {parseArgs} from "util";
import {build, publish} from "./libuild.ts";

const {values, positionals} = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: {type: "boolean", short: "h"},
    version: {type: "boolean", short: "v"},
    save: {type: "boolean"},
    "no-save": {type: "boolean"},
  },
  allowPositionals: true,
  strict: false, // Allow unknown options to be passed through
});

const HELP_TEXT = `
libuild - Zero-config library builds

Usage:
  libuild [command] [options]

Commands:
  build     Build the library (default command)
  publish   Build and publish the library

Options:
  --save    Update root package.json to point to dist files
  --no-save Skip package.json updates (for publish command)

For publish command, all additional flags are forwarded to npm publish.

Examples:
  libuild                 # Build the library
  libuild build --save    # Build and update package.json for npm link
  libuild publish         # Build and publish to npm
  libuild publish --dry-run --tag beta  # Build and publish with npm flags
`;

async function main() {
  if (values.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (values.version) {
    const pkg = await import("../package.json");
    console.log(pkg.version);
    process.exit(0);
  }

  const command = positionals[0] || "build";
  const cwd = process.cwd();

  // Determine save behavior
  const shouldSave = values.save || (command === "publish" && !values["no-save"]);

  // Extract additional arguments for forwarding to npm publish
  const extraArgs = process.argv.slice(2).filter(arg => 
    !["build", "publish"].includes(arg) && 
    !["--save", "--no-save", "--help", "-h", "--version", "-v"].includes(arg)
  );

  try {
    switch (command) {
      case "build":
        await build(cwd, shouldSave);
        break;
      case "publish":
        await publish(cwd, shouldSave, extraArgs);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP_TEXT);
        process.exit(1);
    }
  } catch (error: any) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

main();
