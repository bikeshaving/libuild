#!/usr/bin/env node
import {parseArgs} from "util";
import * as Path from "path";
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
  libuild [command] [directory] [options]

Commands:
  build     Build the library (default command)
  publish   Build and publish the library

Arguments:
  directory Optional directory to build (defaults to current directory)

Options:
  --save    Update root package.json to point to dist files
  --no-save Skip package.json updates (for publish command)

For publish command, all additional flags are forwarded to npm publish.

Examples:
  libuild                 # Build the library in current directory
  libuild build           # Same as above
  libuild ../other-proj   # Build library in ../other-proj
  libuild build --save    # Build and update package.json for npm link
  libuild publish ../lib  # Build and publish library in ../lib
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

  // Parse command and optional directory
  const command = positionals[0] || "build";
  const targetDir = positionals[1];
  const cwd = targetDir ? Path.resolve(targetDir) : process.cwd();

  // Determine save behavior
  const shouldSave = values.save || (command === "publish" && !values["no-save"]);

  // Extract and validate additional arguments for forwarding to npm publish
  const allowedNpmFlags = [
    "--dry-run", "--tag", "--access", "--registry", "--otp", "--provenance",
    "--workspace", "--workspaces", "--include-workspace-root"
  ];
  
  const rawExtraArgs = process.argv.slice(2).filter(arg => 
    !["build", "publish"].includes(arg) && 
    !["--save", "--no-save", "--help", "-h", "--version", "-v"].includes(arg)
  );
  
  // Validate npm arguments for security
  const extraArgs: string[] = [];
  for (let i = 0; i < rawExtraArgs.length; i++) {
    const arg = rawExtraArgs[i];
    
    // Check if it's a known flag
    if (arg.startsWith("--")) {
      const flagName = arg.split("=")[0]; // Handle --flag=value format
      if (allowedNpmFlags.includes(flagName)) {
        extraArgs.push(arg);
        // If this flag expects a value and it's not in --flag=value format, include the next argument
        if (!arg.includes("=") && ["--tag", "--access", "--registry", "--otp", "--workspace"].includes(flagName)) {
          if (i + 1 < rawExtraArgs.length && !rawExtraArgs[i + 1].startsWith("--")) {
            extraArgs.push(rawExtraArgs[i + 1]);
            i++; // Skip the next argument as it's the value
          }
        }
      } else {
        console.warn(`Warning: Ignoring unknown/unsafe npm flag: ${arg}`);
      }
    } else {
      // Non-flag arguments are only allowed as values to flags we've already validated
      // Check if this is a value for a flag that expects one
      const prevArg = i > 0 ? rawExtraArgs[i - 1] : "";
      const isPrevArgValueFlag = ["--tag", "--access", "--registry", "--otp", "--workspace"].includes(prevArg) && 
                                !prevArg.includes("=");
      
      if (isPrevArgValueFlag && extraArgs.includes(prevArg)) {
        // This argument is the value for a flag that was already accepted
        extraArgs.push(arg);
      } else {
        console.warn(`Warning: Ignoring unexpected argument: ${arg}`);
      }
    }
  }

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
