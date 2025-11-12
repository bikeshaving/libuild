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

IMPORTANT:
  • libuild is zero-config - there is NO libuild.config.js file
  • Configuration comes from your package.json (main, module, exports, etc.)
  • Use --save to regenerate package.json fields based on built files
  • Invalid bin/exports paths are automatically cleaned up with --save

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

  // Parse command and optional directory more carefully
  // Need to handle that npm flag values might be in positionals due to strict: false
  const command = positionals[0] || "build";
  
  // Find directory by looking for positionals that are actual directory paths
  // Skip flag values by checking if previous positional was a flag that expects a value
  let targetDir: string | undefined;
  for (let i = 1; i < positionals.length; i++) {
    const arg = positionals[i];
    
    // Skip if this looks like it's a value for a flag
    const flagValueFlags = ["--tag", "--access", "--registry", "--otp", "--workspace"];
    const isValueForFlag = flagValueFlags.some(flag => {
      const flagIndex = process.argv.indexOf(flag);
      const argIndex = process.argv.indexOf(arg);
      return flagIndex !== -1 && argIndex === flagIndex + 1;
    });
    
    if (isValueForFlag) {
      continue;
    }
    
    // Check if this looks like a valid directory path 
    if (!arg.startsWith("--")) {
      try {
        // Only treat as directory if it looks like a project directory
        // Skip system paths like /bin/sh, /usr/bin, etc.
        const isSystemPath = Path.isAbsolute(arg) && (
          arg.startsWith("/bin/") || 
          arg.startsWith("/usr/") || 
          arg.startsWith("/etc/") ||
          arg.startsWith("/var/") ||
          arg.startsWith("/opt/") ||
          arg.startsWith("/tmp/") ||
          arg.startsWith("/System/") ||
          arg.startsWith("/Applications/")
        );
        
        if (isSystemPath) {
          continue;
        }
        
        const resolvedPath = Path.resolve(arg);
        
        // Prefer relative paths or current directory references
        if (arg.includes("/") || arg.includes("\\") || arg === "." || arg === ".." || 
            arg.startsWith("./") || arg.startsWith("../")) {
          targetDir = arg;
          break;
        }
        
        // For simple names, only use if they exist as directories in current working directory
        const fs = await import("fs/promises");
        try {
          const stat = await fs.stat(resolvedPath);
          if (stat.isDirectory() && !Path.isAbsolute(arg)) {
            targetDir = arg;
            break;
          }
        } catch {
          // Doesn't exist, skip it
        }
      } catch {
        // Invalid path, skip it
      }
    }
  }
  
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
    !["--save", "--no-save", "--help", "-h", "--version", "-v"].includes(arg) &&
    arg !== targetDir // Don't filter out the target directory
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
