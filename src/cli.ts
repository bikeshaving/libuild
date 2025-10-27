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
});

const HELP_TEXT = `
libuild - Zero-config library builds

Usage:
  libuild [command]

Commands:
  build     Build the library (default command)
  publish   Build and publish the library

Options:
  --save    Update root package.json to point to dist files
  --no-save Skip package.json updates (for publish command)

Examples:
  libuild                 # Build the library
  libuild build --save    # Build and update package.json for npm link
  libuild publish         # Build and publish to npm
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

  try {
    switch (command) {
      case "build":
        await build(cwd, shouldSave);
        break;
      case "publish":
      case "ship": // backwards compatibility
        await publish(cwd, shouldSave);
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
