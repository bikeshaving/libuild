import * as FS from "fs/promises";
import * as Path from "path";
import {spawn} from "child_process";

import * as ESBuild from "esbuild";
import * as TS from "typescript";
import {umdPlugin} from "./umd-plugin.js";

interface PackageJSON {
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  module?: string;
  types?: string;
  exports?: any;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  [key: string]: any;
}

interface BuildOptions {
  formats: {
    esm: boolean;
    cjs: boolean;
    umd: boolean;
  };
}

function isValidEntrypoint(filename: string): boolean {
  if (!filename.endsWith(".ts") && !filename.endsWith(".js")) return false;
  if (filename.endsWith(".d.ts")) return false; // Ignore TypeScript declaration files
  if (filename.startsWith("_")) return false;
  if (filename.startsWith(".")) return false;
  return true;
}

async function findEntryPoints(srcDir: string): Promise<string[]> {
  const files = await FS.readdir(srcDir);
  return files
    .filter(isValidEntrypoint)
    .map(file => Path.basename(file, Path.extname(file)))
    .sort();
}

async function detectMainEntry(pkg: PackageJSON, entries: string[]): Promise<string> {
  // If exports["."] is specified, try to extract the main entry from it
  if (pkg.exports && pkg.exports["."]) {
    const dotExport = pkg.exports["."];
    let importPath: string | undefined;

    if (typeof dotExport === "string") {
      importPath = dotExport;
    } else if (typeof dotExport === "object" && dotExport.import) {
      importPath = dotExport.import;
    }

    if (importPath) {
      // Extract entry name from path like "./src/foo.js" -> "foo"
      const match = importPath.match(/\.\/src\/([^.]+)/);
      if (match && entries.includes(match[1])) {
        return match[1];
      }
    }
  }

  // If main is specified in package.json, use it
  if (pkg.main && typeof pkg.main === "string") {
    const mainBase = Path.basename(pkg.main, Path.extname(pkg.main));
    if (entries.includes(mainBase)) {
      return mainBase;
    }
  }

  // If there's an index entry, that's the main
  if (entries.includes("index")) {
    return "index";
  }

  // If there's only one entry, that's the main
  if (entries.length === 1) {
    return entries[0];
  }

  // Try to use the package name
  const pkgNameParts = pkg.name.split("/");
  const pkgName = pkgNameParts[pkgNameParts.length - 1];
  if (!pkgName) {
    throw new Error(`Invalid package name: ${pkg.name}`);
  }
  if (entries.includes(pkgName)) {
    return pkgName;
  }

  // Default to first entry alphabetically
  return entries[0];
}

function checkIfExportIsStale(exportKey: string, exportValue: any, entries: string[]): boolean {
  // System exports like package.json are never stale
  if (exportKey === "./package.json" || typeof exportValue === "string" && (exportValue === "./package.json" || exportValue.endsWith("/package.json"))) {
    return false;
  }

  // Extract entry name from export value first (most reliable), then key
  let entryName: string | undefined;
  let hasInvalidPath = false;

  // Try to extract from value first (most reliable)
  if (typeof exportValue === "string") {
    // Check for nested paths first (these are always invalid)
    if (exportValue.match(/\.\/src\/.*\/.*\.(ts|js)$/)) {
      hasInvalidPath = true;
    } else {
      const match = exportValue.match(/\.\/src\/([^/]+)\.(ts|js)$/);
      if (match) {
        const filename = match[1] + "." + match[2];
        // Check if this would be an invalid entrypoint (invalid entrypoints should throw errors, not be treated as stale)
        if (!isValidEntrypoint(filename)) {
          hasInvalidPath = true;
        } else {
          entryName = match[1];
        }
      }
    }
  } else if (typeof exportValue === "object" && exportValue !== null) {
    // Try import field first, then require
    const importPath = exportValue.import || exportValue.require;
    if (typeof importPath === "string") {
      // Check for nested paths first (these are always invalid)
      if (importPath.match(/\.\/src\/.*\/.*\.(ts|js|cjs)$/)) {
        hasInvalidPath = true;
      } else {
        const match = importPath.match(/\.\/src\/([^/]+)\.(ts|js|cjs)$/);
        if (match) {
          const filename = match[1] + "." + match[2].replace('cjs', 'js'); // normalize cjs to js for validation
          if (!isValidEntrypoint(filename)) {
            hasInvalidPath = true;
          } else {
            entryName = match[1];
          }
        }
      }
    }
  }

  // If no entry name from value, try to extract from key (e.g., "./utils" -> "utils", "./utils.js" -> "utils")
  if (!entryName && !hasInvalidPath && exportKey.startsWith("./") && exportKey !== ".") {
    const keyName = exportKey.slice(2).replace(/\.js$/, "");
    if (keyName && !keyName.includes("/")) {
      entryName = keyName;
    }
  }

  // If we found an invalid path, don't treat as stale - let the validation logic handle it
  if (hasInvalidPath) {
    return false;
  }

  // Check if the entry still exists
  return entryName ? !entries.includes(entryName) : false;
}

function generateExports(entries: string[], mainEntry: string, options: BuildOptions, existingExports: any = {}): {exports: any, staleExports: string[]} {
  const exports: any = {};
  const staleExports: string[] = [];

  function createExportEntry(entry: string) {
    const exportEntry: any = {
      types: `./src/${entry}.d.ts`,
      import: `./src/${entry}.js`,
    };
    if (options.formats.cjs) {
      exportEntry.require = `./src/${entry}.cjs`;
    }
    return exportEntry;
  }

  function expandExistingExport(existing: any, entryFromPath?: string) {
    if (typeof existing === "string") {
      // Special case for system exports (package.json, etc.)
      if (existing === "./package.json" || existing.endsWith("/package.json")) {
        return existing;
      }

      // Extract entry name and validate it's a valid entrypoint
      const match = existing.match(/\.\/src\/([^/]+\.(?:ts|js))$/);
      if (match) {
        const filename = match[1];
        if (!isValidEntrypoint(filename)) {
          throw new Error(`Export path '${existing}' references '${filename}' which is not a valid entrypoint. Valid entrypoints cannot start with '_' or '.' and must be .ts/.js files in src/.`);
        }
        const entry = Path.basename(filename, Path.extname(filename));

        // Convert string export to conditional export
        return options.formats.cjs ? {
          types: `./src/${entry}.d.ts`,
          import: existing,
          require: `./src/${entry}.cjs`,
        } : {
          types: `./src/${entry}.d.ts`,
          import: existing,
        };
      }

      // If we have entryFromPath, use it (this is for auto-discovered entries)
      if (entryFromPath) {
        return options.formats.cjs ? {
          types: `./src/${entryFromPath}.d.ts`,
          import: existing,
          require: `./src/${entryFromPath}.cjs`,
        } : {
          types: `./src/${entryFromPath}.d.ts`,
          import: existing,
        };
      }

      throw new Error(`Export path '${existing}' must point to a valid entrypoint in src/ (e.g., './src/utils.js'). Nested directories and internal files (starting with '_' or '.') are not allowed.`);
    } else if (typeof existing === "object" && existing !== null) {
      // Existing object - expand if needed
      if (options.formats.cjs && !existing.require && existing.import) {
        // Validate the import path
        const match = existing.import?.match(/\.\/src\/([^/]+\.(?:ts|js))$/);
        if (match) {
          const filename = match[1];
          if (!isValidEntrypoint(filename)) {
            throw new Error(`Export import path '${existing.import}' references '${filename}' which is not a valid entrypoint. Valid entrypoints cannot start with '_' or '.' and must be .ts/.js files in src/.`);
          }
          const entry = Path.basename(filename, Path.extname(filename));

          return {
            ...existing,
            types: existing.types || `./src/${entry}.d.ts`,
            require: `./src/${entry}.cjs`,
          };
        }

        // If we have entryFromPath, use it
        if (entryFromPath) {
          return {
            ...existing,
            types: existing.types || `./src/${entryFromPath}.d.ts`,
            require: `./src/${entryFromPath}.cjs`,
          };
        }

        throw new Error(`Export import path '${existing.import}' must point to a valid entrypoint in src/ (e.g., './src/utils.js'). Nested directories and internal files are not allowed.`);
      }
      return {
        types: existing.types || `./src/${entryFromPath}.d.ts`,
        ...existing,
      };
    }
    return existing;
  }

  // First, expand all existing exports and detect stale ones
  // The expandExistingExport function will handle validation
  for (const [key, value] of Object.entries(existingExports)) {
    // Check if this export points to a valid entry
    const isStale = checkIfExportIsStale(key, value, entries);
    if (isStale) {
      staleExports.push(key);
    } else {
      exports[key] = expandExistingExport(value);
    }
  }

  // Handle main export - respect existing "." export or create new one
  if (!exports["."]) {
    exports["."] = createExportEntry(mainEntry);
  } else {
    exports["."] = expandExistingExport(exports["."], mainEntry);
  }

  // All entries (including duplicating main for clarity)
  for (const entry of entries) {
    if (entry === "umd") continue; // UMD is special

    const key = `./${entry}`;

    // Only add if not already specified by user
    if (!exports[key]) {
      exports[key] = createExportEntry(entry);
    } else {
      exports[key] = expandExistingExport(exports[key], entry);
    }

    // Legacy .js extension support (only if not user-specified)
    if (!exports[`${key}.js`]) {
      exports[`${key}.js`] = exports[key];
    }

    // Special case for jsx-runtime
    if (entry === "jsx-runtime") {
      if (!exports["./jsx-dev-runtime"]) {
        exports["./jsx-dev-runtime"] = exports[key];
      }
      if (!exports["./jsx-dev-runtime.js"]) {
        exports["./jsx-dev-runtime.js"] = exports[key];
      }
    }
  }

  // UMD export (CommonJS only)
  if (options.formats.umd && !exports["./umd"]) {
    exports["./umd"] = {
      require: "./src/umd.js",
    };
    if (!exports["./umd.js"]) {
      exports["./umd.js"] = exports["./umd"];
    }
  }

  // Package.json export
  if (!exports["./package.json"]) {
    exports["./package.json"] = "./package.json";
  }

  return {exports, staleExports};
}

export function transformSrcToDist(value: any): any {
  if (typeof value === "string") {
    // Add ./ prefix to src references
    if (value.startsWith("src/") || value === "src") {
      return "./" + value;
    }
    return value;
  } else if (Array.isArray(value)) {
    return value.map(transformSrcToDist);
  } else if (typeof value === "object" && value !== null) {
    const transformed: any = {};
    for (const [key, val] of Object.entries(value)) {
      transformed[key] = transformSrcToDist(val);
    }
    return transformed;
  }
  return value;
}

function cleanPackageJSON(pkg: PackageJSON, mainEntry: string, options: BuildOptions): PackageJSON {
  const cleaned: PackageJSON = {
    name: pkg.name,
    version: pkg.version,
  };

  const fieldsToKeep = [
    "description",
    "keywords",
    "author",
    "contributors",
    "maintainers",
    "license",
    "repository",
    "bugs",
    "homepage",
    "funding",
    "bin",
    "scripts",
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundledDependencies",
    "engines",
    "cpu",
    "os",
    "type",
    "types",
    "files",
    "sideEffects",
    "browserslist",
  ];

  const pathFields = ["bin", "files", "types", "scripts"];

  for (const field of fieldsToKeep) {
    if (pkg[field] !== undefined) {
      if (field === "scripts") {
        // Only keep scripts that npm actually runs for installed packages
        const npmLifecycleScripts = ["postinstall", "preinstall", "install", "preuninstall", "postuninstall", "shrinkwrap"];
        const filteredScripts: Record<string, string> = {};
        for (const [scriptName, scriptValue] of Object.entries(pkg[field] || {})) {
          if (npmLifecycleScripts.includes(scriptName)) {
            filteredScripts[scriptName] = scriptValue;
          }
        }
        if (Object.keys(filteredScripts).length > 0) {
          // Apply path transformation to the filtered scripts
          cleaned[field] = transformSrcToDist(filteredScripts);
        }
      } else if (pathFields.includes(field)) {
        cleaned[field] = transformSrcToDist(pkg[field]);
      } else {
        cleaned[field] = pkg[field];
      }
    }
  }

  if (!cleaned.type) {
    cleaned.type = "module";
  }

  if (options.formats.cjs) {
    cleaned.main = `src/${mainEntry}.cjs`;
  }
  cleaned.module = `src/${mainEntry}.js`;
  cleaned.types = `src/${mainEntry}.d.ts`;

  return cleaned;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await FS.access(filePath);
    return true;
  } catch {
    return false;
  }
}


export async function build(cwd: string, save: boolean = false): Promise<{distPkg: PackageJSON, rootPkg: PackageJSON}> {
  console.log("Building with libuild...");

  const srcDir = Path.join(cwd, "src");
  const distDir = Path.join(cwd, "dist");
  const distSrcDir = Path.join(distDir, "src");

  // Check src directory exists
  if (!await fileExists(srcDir)) {
    throw new Error("No src/ directory found");
  }

  // Load package.json
  const pkgPath = Path.join(cwd, "package.json");
  const pkg = JSON.parse(await FS.readFile(pkgPath, "utf-8")) as PackageJSON;

  // Check for unsafe publishing conditions
  if (!pkg.private) {
    console.warn("⚠️  WARNING: Root package.json is not private - this could lead to accidental publishing of development package.json");
    console.warn("   Consider setting 'private: true' in your root package.json");
  }

  // Check if dist directory is gitignored
  const gitignorePath = Path.join(cwd, ".gitignore");
  if (await fileExists(gitignorePath)) {
    const gitignoreContent = await FS.readFile(gitignorePath, "utf-8");
    const isDistIgnored = gitignoreContent.includes("dist/") ||
                         gitignoreContent.includes("/dist") ||
                         gitignoreContent.includes("dist\n") ||
                         gitignoreContent.includes("dist\r\n");

    if (!isDistIgnored) {
      console.warn("⚠️  WARNING: dist/ directory is not in .gitignore - built files should not be committed");
      console.warn("   Add 'dist/' to your .gitignore file");
    }
  }

  // Find entry points
  const entries = await findEntryPoints(srcDir);
  if (entries.length === 0) {
    throw new Error("No entry points found in src/");
  }

  const options: BuildOptions = {
    formats: {
      esm: true, // Always build ESM
      cjs: !!pkg.main, // Generate CJS only if main field exists
      umd: entries.includes("umd")
    }
  };
  
  const mainEntry = await detectMainEntry(pkg, entries);

  console.log("  Found entries:", entries.join(", "));
  console.log("  Main entry:", mainEntry);
  if (options.formats.cjs) {
    console.log("  Formats: ESM, CJS" + (options.formats.umd ? ", UMD" : ""));
  } else {
    console.log("  Formats: ESM" + (options.formats.umd ? ", UMD" : "") + " (no main field - CJS disabled)");
  }

  // Clean dist directory
  if (await fileExists(distDir)) {
    await FS.rm(distDir, {recursive: true});
  }
  await FS.mkdir(distDir, {recursive: true});

  // Prepare entry points for batch building
  const entryPoints: string[] = [];
  const umdEntries: string[] = [];

  for (const entry of entries) {
    const entryPath = Path.join(srcDir, `${entry}.ts`);
    const jsEntryPath = Path.join(srcDir, `${entry}.js`);
    const actualPath = await fileExists(entryPath) ? entryPath : jsEntryPath;

    if (!await fileExists(actualPath)) {
      throw new Error(`Entry point file not found: ${actualPath}. Expected ${entry}.ts or ${entry}.js in src/ directory.`);
    }

    if (entry === "umd") {
      umdEntries.push(actualPath);
    } else {
      entryPoints.push(actualPath);
    }
  }

  // Build all regular entries together for shared chunk deduplication
  if (entryPoints.length > 0) {
    // ESM build with splitting for shared chunks
    console.log(`  Building ${entryPoints.length} entries (ESM)...`);
    await ESBuild.build({
      entryPoints,
      outdir: distSrcDir,
      format: "esm",
      entryNames: "[name]",
      outExtension: {".js": ".js"},
      bundle: true,
      splitting: true, // Enable shared chunk extraction
      minify: false,
      sourcemap: true,
      external: Object.keys(pkg.dependencies || {}),
      platform: "node",
      target: "node16",
    });

    // CJS build (only if main field exists)
    if (options.formats.cjs) {
      console.log(`  Building ${entryPoints.length} entries (CJS)...`);
      await ESBuild.build({
        entryPoints,
        outdir: distSrcDir,
        format: "cjs",
        entryNames: "[name]",
        outExtension: {".js": ".cjs"},
        bundle: true,
        minify: false,
        sourcemap: true,
        external: Object.keys(pkg.dependencies || {}),
        platform: "node",
        target: "node16",
        // Note: CJS doesn't support splitting, but building together still helps with consistency
      });
    }
  }

  // Build UMD entries separately (they need special plugin handling)
  for (const umdPath of umdEntries) {
    const entry = Path.basename(umdPath, Path.extname(umdPath));
    console.log(`  Building ${entry} (UMD)...`);
    const globalName = pkg.name.includes("/")
      ? pkg.name.split("/").pop()!.replace(/-/g, "").charAt(0).toUpperCase() + pkg.name.split("/").pop()!.replace(/-/g, "").slice(1)
      : pkg.name.replace(/-/g, "").charAt(0).toUpperCase() + pkg.name.replace(/-/g, "").slice(1);

    await ESBuild.build({
      entryPoints: [umdPath],
      outdir: distSrcDir,
      format: "cjs",
      entryNames: "[name]",
      bundle: true,
      minify: false,
      sourcemap: true,
      external: Object.keys(pkg.dependencies || {}),
      platform: "node",
      target: "node16",
      plugins: [umdPlugin({globalName})],
    });
  }

  // Generate TypeScript declarations using TypeScript compiler API
  console.log("  Generating TypeScript declarations...");

  // Find all TypeScript source files (including UMD entries)
  const allTsFiles = [...entryPoints, ...umdEntries].filter(file => file.endsWith('.ts'));

  if (allTsFiles.length > 0) {
    const compilerOptions: TS.CompilerOptions = {
      declaration: true,
      emitDeclarationOnly: true,
      outDir: distSrcDir,
      rootDir: srcDir,
      skipLibCheck: true,
      esModuleInterop: true,
      target: TS.ScriptTarget.ES2020,
      module: TS.ModuleKind.ESNext,
    };

    // Create program with explicit config to avoid tsconfig.json interference
    const program = TS.createProgram(allTsFiles, compilerOptions);
    const emitResult = program.emit();

    if (emitResult.diagnostics.length > 0) {
      const diagnostics = TS.formatDiagnosticsWithColorAndContext(emitResult.diagnostics, {
        getCanonicalFileName: path => path,
        getCurrentDirectory: () => cwd,
        getNewLine: () => '\n'
      });
      throw new Error(`TypeScript declaration generation failed:\n${diagnostics}`);
    }

  }

  // Add triple-slash references for Deno
  for (const entry of entries) {
    if (entry === "umd") continue;

    const jsPath = Path.join(distSrcDir, `${entry}.js`);
    const dtsPath = Path.join(distSrcDir, `${entry}.d.ts`);

    if (await fileExists(jsPath) && await fileExists(dtsPath)) {
      const content = await FS.readFile(jsPath, "utf-8");
      await FS.writeFile(jsPath, `/// <reference types="./${entry}.d.ts" />\n${content}`);
    }
  }

  // Initialize auto-discovered files tracking
  const autoDiscoveredFiles: string[] = [];

  // Generate package.json
  console.log("  Generating package.json...");
  const cleanedPkg = cleanPackageJSON(pkg, mainEntry, options);
  const exportsResult = generateExports(entries, mainEntry, options, pkg.exports);
  cleanedPkg.exports = exportsResult.exports;

  // Handle stale exports
  if (exportsResult.staleExports.length > 0) {
    console.warn(`⚠️  WARNING: Found ${exportsResult.staleExports.length} stale export(s) pointing to missing src/ files:`);
    for (const staleExport of exportsResult.staleExports) {
      console.warn(`   - ${staleExport}`);
    }
    if (save) {
      console.log("   Removing stale exports from root package.json (--save mode)");
    } else {
      console.warn("   Use --save to remove these from root package.json");
    }
  }

  // Add auto-discovered files to dist package.json files field
  if (cleanedPkg.files && Array.isArray(cleanedPkg.files)) {
    for (const autoFile of autoDiscoveredFiles) {
      if (!cleanedPkg.files.includes(autoFile)) {
        cleanedPkg.files.push(autoFile);
      }
    }
  }

  await FS.writeFile(
    Path.join(distDir, "package.json"),
    JSON.stringify(cleanedPkg, null, 2) + "\n"
  );

  // Copy additional files
  const defaultFilesToCopy = ["README.md", "LICENSE", "CHANGELOG.md"];

  // Copy default files
  for (const file of defaultFilesToCopy) {
    const srcPath = Path.join(cwd, file);
    if (await fileExists(srcPath)) {
      console.log(`  Copying ${file}...`);
      await FS.copyFile(srcPath, Path.join(distDir, file));
    }
  }

  // Auto-discover and add common files to files field if files field exists
  const commonFiles = ["README.md", "LICENSE", "CHANGELOG.md", "COPYING", "AUTHORS"];
  if (pkg.files && Array.isArray(pkg.files)) {
    for (const commonFile of commonFiles) {
      const commonPath = Path.join(cwd, commonFile);
      if (await fileExists(commonPath) && !pkg.files.includes(commonFile)) {
        console.log(`  Auto-discovered ${commonFile}, adding to files field...`);
        pkg.files.push(commonFile);
        autoDiscoveredFiles.push(commonFile);
      }
    }
  }

  // Copy files specified in package.json files field
  if (pkg.files && Array.isArray(pkg.files)) {
    console.log("  Copying files from package.json files field...");

    for (const pattern of pkg.files) {
      if (typeof pattern === "string" && (pattern.includes("src") || pattern.includes("dist"))) {
        // Skip src/dist patterns as they're handled by the build process
        continue;
      }

      if (typeof pattern === "string") {
        const srcPath = Path.join(cwd, pattern);
        const destPath = Path.join(distDir, pattern);

        if (await fileExists(srcPath)) {
          const stat = await FS.stat(srcPath);
          if (stat.isDirectory()) {
            console.log(`  Copying directory ${pattern}/...`);
            await FS.mkdir(Path.dirname(destPath), {recursive: true});
            await FS.cp(srcPath, destPath, {recursive: true});
          } else {
            console.log(`  Copying ${pattern}...`);
            await FS.mkdir(Path.dirname(destPath), {recursive: true});
            await FS.copyFile(srcPath, destPath);
          }
        } else if (pattern.includes("*")) {
          const baseDir = pattern.split("*")[0].replace(/\/$/, "");
          if (baseDir && await fileExists(Path.join(cwd, baseDir))) {
            console.log(`  Copying pattern ${pattern}...`);
            const baseSrcPath = Path.join(cwd, baseDir);
            const baseDestPath = Path.join(distDir, baseDir);
            await FS.mkdir(Path.dirname(baseDestPath), {recursive: true});
            await FS.cp(baseSrcPath, baseDestPath, {recursive: true});
          } else {
            throw new Error(`Pattern base directory not found for "${pattern}". Expected directory: ${Path.join(cwd, baseDir)}`);
          }
        } else {
          throw new Error(`File specified in files field not found: ${srcPath}. Remove "${pattern}" from package.json files field or create the file.`);
        }
      } else {
        throw new Error(`Invalid files field entry: ${JSON.stringify(pattern)}. Files field entries must be strings.`);
      }
    }
  }

  if (save) {
    console.log("  Updating root package.json...");
    const rootPkg = {...pkg};

    rootPkg.private = true;

    // Update main/module/types to point to dist
    if (options.formats.cjs) {
      rootPkg.main = `./dist/src/${mainEntry}.cjs`;
    }
    rootPkg.module = `./dist/src/${mainEntry}.js`;
    rootPkg.types = `./dist/src/${mainEntry}.d.ts`;

    if (rootPkg.typings && typeof rootPkg.typings === "string") {
      rootPkg.typings = rootPkg.typings.startsWith("./dist/") ? rootPkg.typings : "./" + Path.join("dist", rootPkg.typings);
    }

    // Update exports to point to dist
    const rootExports: any = {};
    for (const [key, value] of Object.entries(cleanedPkg.exports)) {
      if (typeof value === "string") {
        rootExports[key] = `./dist${value.startsWith('.') ? value.slice(1) : value}`;
      } else if (typeof value === "object" && value !== null) {
        rootExports[key] = {};
        for (const [subKey, subValue] of Object.entries(value)) {
          if (typeof subValue === "string") {
            rootExports[key][subKey] = `./dist${subValue.startsWith('.') ? subValue.slice(1) : subValue}`;
          }
        }
      }
    }
    rootPkg.exports = rootExports;

    // Update bin to point to dist
    if (rootPkg.bin) {
      if (typeof rootPkg.bin === "string") {
        if (!rootPkg.bin.startsWith("./dist/")) {
          rootPkg.bin = "./" + Path.join("dist", rootPkg.bin);
        }
      } else {
        for (const [name, binPath] of Object.entries(rootPkg.bin)) {
          if (typeof binPath === "string" && !binPath.startsWith("./dist/")) {
            rootPkg.bin[name] = "./" + Path.join("dist", binPath);
          }
        }
      }
    }

    // Only modify files field if it existed in the original package.json
    if (pkg.files !== undefined) {
      if (!rootPkg.files) {
        rootPkg.files = [];
      } else if (!Array.isArray(rootPkg.files)) {
        rootPkg.files = [rootPkg.files];
      }

      // Add any auto-discovered files that aren't already in root files
      for (const autoFile of autoDiscoveredFiles) {
        if (!rootPkg.files.includes(autoFile)) {
          rootPkg.files.push(autoFile);
        }
      }

      // Ensure dist/ is included in files
      if (!rootPkg.files.includes("dist/") && !rootPkg.files.includes("dist")) {
        rootPkg.files.push("dist/");
      }
    }

    await FS.writeFile(pkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
  } else {
    console.log("  Skipping root package.json update (use --save to enable)");
  }

  console.log("\nBuild complete!");

  // Show summary
  console.log(`\n  Output: ${distDir}`);
  console.log(`\n  Entries: ${entries.length}`);
  if (options.formats.cjs) {
    console.log(`\n  Formats: ESM, CJS${options.formats.umd ? ", UMD" : ""}`);
  } else {
    console.log(`\n  Formats: ESM${options.formats.umd ? ", UMD" : ""}`);
  }

  // Create rootPkg based on whether --save was used
  let rootPkg = pkg;
  if (save) {
    // rootPkg was already created and saved above
    rootPkg = JSON.parse(await FS.readFile(pkgPath, "utf-8")) as PackageJSON;
  }

  return {distPkg: cleanedPkg, rootPkg};
}

export async function publish(cwd: string, save: boolean = true) {
  await build(cwd, save);

  console.log("\nPublishing to npm...");

  const distDir = Path.join(cwd, "dist");
  const distPkgPath = Path.join(distDir, "package.json");

  if (!await fileExists(distPkgPath)) {
    throw new Error("No dist/package.json found. Run 'libuild build' first.");
  }

  // Run npm publish in dist directory
  const proc = spawn("npm", ["publish"], {
    cwd: distDir,
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolve) => {
    proc.on("close", resolve);
  });

  if (exitCode === 0) {
    const distPkg = JSON.parse(await FS.readFile(distPkgPath, "utf-8")) as PackageJSON;
    console.log(`\nPublished ${distPkg.name}@${distPkg.version}!`);
  } else {
    throw new Error("npm publish failed");
  }
}
