import * as FS from "fs/promises";
import * as Path from "path";
import {spawn} from "child_process";

import * as ESBuild from "esbuild";
import {umdPlugin} from "./plugins/umd.js";
import {externalEntrypointsPlugin} from "./plugins/external.js";
import {dtsPlugin} from "./plugins/dts.js";

// Generate runtime detection banner for bin entries
function generateRuntimeBanner(pkg: PackageJSON): string {
  const prefersBun = pkg.engines?.bun !== undefined;

  if (prefersBun) {
    // Allow bun for direct execution if engines.bun is specified
    return '\':\' //; exec "$({ [ "${npm_config_user_agent#bun/}" != "$npm_config_user_agent" ] || true; } && command -v bun || command -v node)" "$0" "$@"';
  } else {
    // Only use bun when explicitly bun run is used
    return '\':\' //; exec "$([ "${npm_config_user_agent#bun/}" != "$npm_config_user_agent" ] && command -v bun || command -v node)" "$0" "$@"';
  }
}

// Handle shebang replacement and banner injection for JavaScript executables
async function processJavaScriptExecutable(filePath: string, runtimeBanner: string): Promise<void> {
  try {
    const contents = await FS.readFile(filePath, 'utf8');
    const lines = contents.split('\n');
    let modified = false;
    
    if (lines[0]?.startsWith('#!')) {
      const existingShebang = lines[0];
      
      // Warn about non-JavaScript shebangs on .js/.ts files
      if (existingShebang.includes('python') || 
          existingShebang.includes('bash') || 
          (!existingShebang.includes('node') && 
           !existingShebang.includes('bun') && 
           !existingShebang.includes('sh'))) {
        console.warn(`⚠️  WARNING: ${filePath} has non-JavaScript shebang but is a JS file. Adding dual runtime support.`);
      }
      
      // Replace any shebang with shell for dual runtime
      lines[0] = '#!/usr/bin/env sh';
      lines.splice(1, 0, runtimeBanner);
      modified = true;
    } else {
      // No shebang - add shell + dual runtime
      lines.unshift('#!/usr/bin/env sh', runtimeBanner);
      modified = true;
    }
    
    if (modified) {
      await FS.writeFile(filePath, lines.join('\n'));
    }
  } catch (error) {
    console.warn(`⚠️  WARNING: Could not process executable ${filePath}: ${error.message}`);
  }
}

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
  
  // Auto-ignore common test file patterns
  if (filename.includes(".test.")) return false; // Jest/Vitest standard
  if (filename.includes(".spec.")) return false; // Jasmine/Angular standard
  
  return true;
}

async function findEntrypoints(srcDir: string): Promise<string[]> {
  const files = await FS.readdir(srcDir, {withFileTypes: true});
  return files
    .filter(dirent => {
      if (dirent.isDirectory()) {
        // Auto-ignore common test directories
        if (dirent.name === "__tests__" || dirent.name === "test") return false;
        return false; // Only process files, not directories
      }
      return isValidEntrypoint(dirent.name);
    })
    .map(dirent => Path.basename(dirent.name, Path.extname(dirent.name)))
    .sort();
}

async function findBinEntrypoints(binDir: string): Promise<string[]> {
  try {
    const files = await FS.readdir(binDir, {withFileTypes: true});
    return files
      .filter(dirent => {
        if (dirent.isDirectory()) {
          return false; // Only process files, not directories
        }
        return isValidEntrypoint(dirent.name);
      })
      .map(dirent => Path.basename(dirent.name, Path.extname(dirent.name)))
      .sort();
  } catch (error) {
    // If bin directory doesn't exist, return empty array
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function detectMainEntry(pkg: PackageJSON, entries: string[]): string | undefined {
  // Helper function to extract entry name from path
  function extractEntryFromPath(path: string): string | undefined {
    const match = path.match(/\.\/src\/([^.]+)/);
    return match ? match[1] : undefined;
  }

  // 1. Check exports["."] first (most specific)
  if (pkg.exports && pkg.exports["."]) {
    const dotExport = pkg.exports["."];
    let importPath: string | undefined;

    if (typeof dotExport === "string") {
      importPath = dotExport;
    } else if (typeof dotExport === "object" && dotExport.import) {
      importPath = dotExport.import;
    }

    if (importPath) {
      const entry = extractEntryFromPath(importPath);
      if (entry && entries.includes(entry)) {
        return entry;
      }
    }
  }

  // 2. Check main field
  if (pkg.main && typeof pkg.main === "string") {
    const mainBase = Path.basename(pkg.main, Path.extname(pkg.main));
    if (entries.includes(mainBase)) {
      return mainBase;
    }
  }

  // 3. Check module field
  if (pkg.module && typeof pkg.module === "string") {
    const moduleBase = Path.basename(pkg.module, Path.extname(pkg.module));
    if (entries.includes(moduleBase)) {
      return moduleBase;
    }
  }

  // 4. If there's an index entry, that's the main
  if (entries.includes("index")) {
    return "index";
  }

  // 5. If there's only one entry, that's the main
  if (entries.length === 1) {
    return entries[0];
  }

  // 6. Try to use the package name
  const pkgNameParts = pkg.name.split("/");
  const pkgName = pkgNameParts[pkgNameParts.length - 1];
  if (!pkgName) {
    throw new Error(`Invalid package name: ${pkg.name}`);
  }
  if (entries.includes(pkgName)) {
    return pkgName;
  }

  // 7. Default to first entry alphabetically (or undefined if no entries)
  return entries[0]; // May be undefined if entries is empty
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
      } else if (exportValue.startsWith("./") && !exportValue.includes("package.json")) {
        // Path doesn't point to src/ - this is invalid and should be validated
        hasInvalidPath = true;
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
        } else if (importPath.startsWith("./") && !importPath.includes("package.json")) {
          // Path doesn't point to src/ - this is invalid and should be validated
          hasInvalidPath = true;
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

async function generateExports(entries: string[], mainEntry: string | undefined, options: BuildOptions, existingExports: any = {}, distDir?: string, allBinEntries: Array<{name: string, source: string}> = []): Promise<{exports: any, staleExports: string[]}> {
  const exports: any = {};
  const staleExports: string[] = [];

  async function createExportEntry(entry: string) {
    if (entry.startsWith("bin/")) {
      // Bin entries only get ESM format (no CJS for executables)
      const binEntry = entry.replace("bin/", "");
      const exportEntry: any = {};

      // Only include types if .d.ts file exists
      if (distDir) {
        const dtsPath = Path.join(distDir, "bin", `${binEntry}.d.ts`);
        if (await fileExists(dtsPath)) {
          exportEntry.types = `./bin/${binEntry}.d.ts`;
        }
      }

      exportEntry.import = `./bin/${binEntry}.js`;

      return exportEntry;
    } else {
      // Regular src entries get both ESM and CJS (if enabled)
      const exportEntry: any = {};

      // Only include types if .d.ts file exists
      if (distDir) {
        const dtsPath = Path.join(distDir, "src", `${entry}.d.ts`);
        const exists = await fileExists(dtsPath);
        if (exists) {
          exportEntry.types = `./src/${entry}.d.ts`;
        }
      }

      exportEntry.import = `./src/${entry}.js`;

      if (options.formats.cjs) {
        exportEntry.require = `./src/${entry}.cjs`;
      }
      return exportEntry;
    }
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
  // Only create "." export if we have a mainEntry (skip for bin-only packages)
  if (mainEntry) {
    if (!exports["."]) {
      exports["."] = await createExportEntry(mainEntry);
    } else {
      exports["."] = expandExistingExport(exports["."], mainEntry);
    }
  }

  // All entries (including duplicating main for clarity)
  for (const entry of entries) {
    if (entry === "umd") continue; // UMD is special

    const key = `./${entry}`;

    // Only add if not already specified by user
    if (!exports[key]) {
      exports[key] = await createExportEntry(entry);
    } else {
      exports[key] = expandExistingExport(exports[key], entry);
    }

    // Legacy .js extension support (only if not user-specified)
    if (!exports[`${key}.js`]) {
      exports[`${key}.js`] = exports[key];
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

async function validateBinPaths(value: any, cwd: string, save: boolean, fieldName: string = "bin"): Promise<void> {
  if (typeof value === "string") {
    await validateSingleBinPath(value, fieldName, cwd, save);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === "string") {
        await validateSingleBinPath(val, `${fieldName}.${key}`, cwd, save);
      }
    }
  }
}

async function validateSingleBinPath(binPath: string, fieldName: string, cwd: string, save: boolean): Promise<void> {
  // If --save is enabled, don't warn because --save will fix the paths
  if (save) {
    return;
  }
  
  // If this points to a dist/src/ or dist/bin/ path (valid libuild output), check if it actually exists
  if (binPath.startsWith("dist/src/") || binPath.startsWith("./dist/src/") || 
      binPath.startsWith("dist/bin/") || binPath.startsWith("./dist/bin/")) {
    const fullPath = Path.join(cwd, binPath);
    const distExists = await fileExists(fullPath);
    
    if (distExists) {
      // This is a valid built file, no warning needed
      return;
    }
    
    // Extract the corresponding src/ or bin/ path to suggest
    let srcPath: string;
    let sourceDir: string;
    
    if (binPath.startsWith("./dist/src/")) {
      srcPath = binPath.replace("./dist/src/", "src/");
      sourceDir = "src";
    } else if (binPath.startsWith("dist/src/")) {
      srcPath = binPath.replace("dist/src/", "src/");
      sourceDir = "src";
    } else if (binPath.startsWith("./dist/bin/")) {
      srcPath = binPath.replace("./dist/bin/", "bin/");
      sourceDir = "bin";
    } else if (binPath.startsWith("dist/bin/")) {
      srcPath = binPath.replace("dist/bin/", "bin/");
      sourceDir = "bin";
    } else {
      srcPath = binPath;
      sourceDir = "src";
    }
      
    // Check if source file exists
    const basePath = srcPath.replace(/\.(js|cjs|mjs)$/, "");
    const tsPath = Path.join(cwd, basePath + ".ts");
    const jsPath = Path.join(cwd, basePath + ".js");
    
    const srcExists = await fileExists(tsPath) || await fileExists(jsPath);
    
    if (!srcExists) {
      console.warn(`⚠️  WARNING: ${fieldName} field points to "${binPath}" but neither the dist file nor corresponding src file exists.
   
   Create "${srcPath}" and run 'libuild build --save' to update paths correctly.`);
      return;
    }
    
    // Source exists but dist doesn't - suggest build
    console.warn(`⚠️  WARNING: ${fieldName} field points to "${binPath}" which doesn't exist yet.
   
   Run 'libuild build' to create the dist files, or use 'libuild build --save' to update the path to "${srcPath}".`);
    return;
  }
  
  // Check other dist/ patterns that aren't libuild's standard output
  if (binPath.startsWith("dist/") || binPath.startsWith("./dist/")) {
    console.warn(`⚠️  WARNING: ${fieldName} field points to "${binPath}" in dist/ directory.
   
   libuild expects bin entries to point to src/ files. Consider changing to the corresponding src/ path and using --save.`);
    return;
  }
  
  // Check if path points to a valid file that would exist after building
  const fullPath = Path.join(cwd, binPath);
  const pathExists = await fileExists(fullPath);
  
  // If the exact path exists, no warning needed
  if (pathExists) {
    return;
  }
  
  // For src/ or bin/ paths, check if a corresponding .ts or .js file exists
  if (binPath.startsWith("src/") || binPath.startsWith("./src/") || 
      binPath.startsWith("bin/") || binPath.startsWith("./bin/")) {
    
    // Check if this is a non-top-level src/ file (in a subdirectory)
    let normalizedPath = binPath.startsWith("./") ? binPath.slice(2) : binPath;
    if (normalizedPath.startsWith("src/")) {
      const srcRelativePath = normalizedPath.replace("src/", "");
      if (srcRelativePath.includes("/")) {
        console.warn(`⚠️  WARNING: ${fieldName} field points to "${binPath}" which is in a subdirectory of src/.`);
        console.warn(`   libuild only auto-detects top-level src/ files as entrypoints.`);
        console.warn(`   Consider moving the file to the top-level src/ directory or use the bin/ directory for executables.`);
      }
    }
    
    const basePath = fullPath.replace(/\.(js|cjs|mjs)$/, "");
    const tsPath = basePath + ".ts";
    const jsPath = basePath + ".js";
    
    const tsExists = await fileExists(tsPath);
    const jsExists = await fileExists(jsPath);
    
    // If source file exists (either .ts or .js), this is valid
    if (tsExists || jsExists) {
      return;
    }
  }
  
  // Only warn if the path doesn't point to a valid entrypoint
  console.warn(`⚠️  WARNING: ${fieldName} field points to "${binPath}" which doesn't exist
   
   libuild is ZERO-CONFIG - there is no libuild.config.js file!
   Configuration comes from your package.json fields.
   
   Use 'libuild build --save' to update package.json with correct dist/ paths automatically.`);
}

function transformBinPaths(value: any): any {
  if (typeof value === "string") {
    // Transform ./dist/src/ paths to src/ without ./ prefix for npm conventions
    if (value.startsWith("./dist/src/")) {
      return value.replace("./dist/", "");
    }
    // Transform dist/src/ paths to src/ without ./ prefix for npm conventions  
    if (value.startsWith("dist/src/")) {
      return value.replace("dist/", "");
    }
    // Transform ./dist/bin/ paths to bin/ without ./ prefix for npm conventions
    if (value.startsWith("./dist/bin/")) {
      return value.replace("./dist/", "");
    }
    // Transform dist/bin/ paths to bin/ without ./ prefix for npm conventions  
    if (value.startsWith("dist/bin/")) {
      return value.replace("dist/", "");
    }
    // Transform ./src/ paths (including nested) to src/ without ./ prefix for npm conventions
    if (value.startsWith("./src/")) {
      return value.replace("./", "");
    }
    // Transform ./bin/ paths to bin/ without ./ prefix for npm conventions
    if (value.startsWith("./bin/")) {
      return value.replace("./", "");
    }
    // Don't add ./ prefix for src/ or bin/ paths
    if (value.startsWith("src/") || value === "src" || value.startsWith("bin/") || value === "bin") {
      return value;
    }
    return value;
  } else if (typeof value === "object" && value !== null) {
    const transformed: any = {};
    for (const [key, val] of Object.entries(value)) {
      transformed[key] = transformBinPaths(val);
    }
    return transformed;
  }
  return value;
}

function fixExportsForDist(obj: any): any {
  if (typeof obj === "string") {
    // Fix paths that incorrectly have ./dist/dist/dist/... -> ./src/
    if (obj.includes("/dist/") && obj.includes("/src/")) {
      // Extract everything after the last /src/
      const match = obj.match(/.*\/src\/(.*)$/);
      if (match) {
        return `./src/${match[1]}`;
      }
    }
    // Fix paths that incorrectly start with ./dist/src/ -> ./src/
    if (obj.startsWith("./dist/src/")) {
      return obj.replace("./dist/src/", "./src/");
    }
    // Fix package.json path
    if (obj.includes("/dist/") && obj.endsWith("/package.json")) {
      return "./package.json";
    }
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.map(fixExportsForDist);
  } else if (typeof obj === "object" && obj !== null) {
    const fixed: any = {};
    for (const [key, val] of Object.entries(obj)) {
      // Handle special cases for package.json fields
      if (key === "files" && Array.isArray(val)) {
        // For files field in dist package.json, remove "dist/" entries since we're already in dist
        fixed[key] = val.filter((file: string) => file !== "dist/" && file !== "dist").concat(val.includes("dist/") || val.includes("dist") ? ["src/"] : []);
      } else if (key === "bin") {
        // Don't transform bin field - it's already been processed by transformBinPaths
        fixed[key] = val;
      } else {
        fixed[key] = fixExportsForDist(val);
      }
    }
    return fixed;
  }
  return obj;
}

async function setExecutablePermissions(filePath: string): Promise<void> {
  try {
    await FS.chmod(filePath, 0o755);
  } catch (error) {
    console.warn(`⚠️  WARNING: Could not set executable permissions for ${filePath}: ${error.message}`);
  }
}

async function makeFilesExecutable(pkg: PackageJSON, cwd: string, allBinEntries: Array<{name: string, source: string}>, runtimeBanner: string): Promise<void> {
  const filesToMakeExecutable: string[] = [];
  const filesToProcessForDualRuntime: string[] = [];
  const distDir = Path.join(cwd, "dist");

  // Files referenced in package.json bin field (from dist/package.json)
  // These paths are relative to dist/, so we need to join with distDir
  if (pkg.bin) {
    if (typeof pkg.bin === 'string') {
      const fullPath = Path.join(distDir, pkg.bin);
      filesToMakeExecutable.push(fullPath);
      // Only process .js files (not .cjs) for dual runtime
      if (pkg.bin.endsWith('.js')) {
        filesToProcessForDualRuntime.push(fullPath);
      }
    } else if (typeof pkg.bin === 'object') {
      for (const binPath of Object.values(pkg.bin)) {
        if (typeof binPath === 'string') {
          const fullPath = Path.join(distDir, binPath);
          filesToMakeExecutable.push(fullPath);
          // Only process .js files (not .cjs) for dual runtime
          if (binPath.endsWith('.js')) {
            filesToProcessForDualRuntime.push(fullPath);
          }
        }
      }
    }
  }

  // All files built from bin/ directories
  const binDirFiles = new Set<string>();
  for (const binEntryInfo of allBinEntries) {
    const baseDir = binEntryInfo.source === 'src' ? "dist/src/bin" : "dist/bin";
    const jsPath = Path.join(cwd, baseDir, `${binEntryInfo.name}.js`);
    const cjsPath = Path.join(cwd, baseDir, `${binEntryInfo.name}.cjs`);

    binDirFiles.add(jsPath);

    // Add to list if not already included
    if (!filesToMakeExecutable.includes(jsPath)) {
      filesToMakeExecutable.push(jsPath);
    }
    if (!filesToMakeExecutable.includes(cjsPath)) {
      filesToMakeExecutable.push(cjsPath);
    }
  }

  // Process dual runtime shebang for package.json bin entries (excluding bin/ directory files)
  // bin/ directory files are already processed during the build
  for (const filePath of filesToProcessForDualRuntime) {
    if (await fileExists(filePath) && !binDirFiles.has(filePath)) {
      await processJavaScriptExecutable(filePath, runtimeBanner);
    }
  }

  // Set executable permissions
  for (const filePath of filesToMakeExecutable) {
    if (await fileExists(filePath)) {
      await setExecutablePermissions(filePath);
    }
  }
}

async function resolveWorkspaceDependencies(dependencies: Record<string, string> | undefined, cwd: string): Promise<Record<string, string> | undefined> {
  if (!dependencies) return undefined;
  
  const resolved: Record<string, string> = {};
  
  for (const [depName, depVersion] of Object.entries(dependencies)) {
    if (depVersion.startsWith("workspace:")) {
      // Resolve workspace dependency to actual version
      const resolvedVersion = await resolveWorkspaceVersion(depName, depVersion, cwd);
      resolved[depName] = resolvedVersion;
    } else {
      // Keep non-workspace dependencies as-is
      resolved[depName] = depVersion;
    }
  }
  
  return resolved;
}

async function resolveWorkspaceVersion(packageName: string, workspaceSpec: string, cwd: string): Promise<string> {
  try {
    // For workspace:*, find the actual package.json and get its version
    if (workspaceSpec === "workspace:*") {
      // Try to find the package in the workspace
      // Look for package.json files in common workspace locations
      const packageNameParts = packageName.replace('@', '').replace('/', '-');
      const packageBaseName = packageName.split('/').pop() || packageName;
      
      const possiblePaths = [
        `../packages/${packageNameParts}/package.json`,
        `../packages/${packageBaseName}/package.json`,
        `../${packageNameParts}/package.json`,
        `../${packageBaseName}/package.json`,
        `./packages/${packageNameParts}/package.json`,
        `./packages/${packageBaseName}/package.json`,
        `./${packageNameParts}/package.json`,
        `./${packageBaseName}/package.json`,
      ];
      
      for (const pkgPath of possiblePaths) {
        try {
          const resolvedPath = Path.resolve(cwd, pkgPath);
          if (await fileExists(resolvedPath)) {
            const pkgContent = await FS.readFile(resolvedPath, 'utf-8');
            const pkgJson = JSON.parse(pkgContent);
            if (pkgJson.name === packageName) {
              console.info(`  Resolved workspace:* dependency "${packageName}" to ^${pkgJson.version}`);
              return `^${pkgJson.version}`;
            }
          }
        } catch {
          // Continue to next path
          continue;
        }
      }
      
      // If we can't find the package, warn and keep the workspace reference
      console.warn(`⚠️  WARNING: Could not resolve workspace dependency "${packageName}" - keeping as workspace:*`);
      console.warn(`    Searched in: ${possiblePaths.map(p => Path.resolve(cwd, p)).join(', ')}`);
      return workspaceSpec;
    }
    
    // For other workspace specs like workspace:^1.0.0, extract the version part
    const versionPart = workspaceSpec.replace('workspace:', '');
    if (versionPart !== '*') {
      console.info(`  Resolved workspace:${versionPart} dependency "${packageName}" to ${versionPart}`);
      return versionPart;
    }
    
    return workspaceSpec;
  } catch (error) {
    console.warn(`⚠️  WARNING: Error resolving workspace dependency "${packageName}": ${error.message}`);
    return workspaceSpec;
  }
}

async function cleanPackageJSON(pkg: PackageJSON, mainEntry: string | undefined, options: BuildOptions, cwd: string, distDir?: string): Promise<PackageJSON> {
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
    "devDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
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
    "private",
  ];

  const pathFields = ["files", "types", "scripts"];

  for (const field of fieldsToKeep) {
    if (pkg[field] !== undefined) {
      if (field === "scripts") {
        // Don't copy scripts to dist - they won't work (can't reference dev scripts/files)
        // Skip this field entirely
        continue;
      } else if (field === "bin") {
        // Apply path transformation to bin field (without ./ prefix for npm convention)
        cleaned[field] = transformBinPaths(pkg[field]);
      } else if (pathFields.includes(field)) {
        cleaned[field] = transformSrcToDist(pkg[field]);
      } else if (field === "dependencies" || field === "devDependencies" || field === "peerDependencies" || field === "optionalDependencies") {
        // Resolve workspace:* dependencies to actual version numbers
        cleaned[field] = await resolveWorkspaceDependencies(pkg[field], cwd);
      } else {
        cleaned[field] = pkg[field];
      }
    }
  }

  if (!cleaned.type) {
    cleaned.type = "module";
  }

  // Only set main/module/types for packages with a main entry
  // Bin-only packages don't need these fields
  if (mainEntry) {
    if (options.formats.cjs) {
      cleaned.main = `src/${mainEntry}.cjs`;
    }
    cleaned.module = `src/${mainEntry}.js`;

    // Only include types field if .d.ts file exists
    if (distDir) {
      const dtsPath = Path.join(distDir, "src", `${mainEntry}.d.ts`);
      const exists = await fileExists(dtsPath);
      if (exists) {
        cleaned.types = `src/${mainEntry}.d.ts`;
      }
    }
  }

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

function validatePath(inputPath: string, basePath: string): string {
  // Reject absolute paths
  if (Path.isAbsolute(inputPath)) {
    throw new Error(`Absolute paths are not allowed: ${inputPath}`);
  }
  
  // Reject paths containing path traversal
  if (inputPath.includes("..")) {
    throw new Error(`Path traversal is not allowed: ${inputPath}`);
  }
  
  // Resolve the path and ensure it's within the base directory
  const resolvedPath = Path.resolve(basePath, inputPath);
  const resolvedBase = Path.resolve(basePath);
  
  if (!resolvedPath.startsWith(resolvedBase + Path.sep) && resolvedPath !== resolvedBase) {
    throw new Error(`Path ${inputPath} resolves outside the project directory`);
  }
  
  return resolvedPath;
}


export async function build(cwd: string, save: boolean = false): Promise<{distPkg: PackageJSON, rootPkg: PackageJSON}> {
  console.info("Building with libuild...");
  console.info("  Zero-config library build tool - configuration from package.json");

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

  // Validate bin paths early to provide clear error messages
  if (pkg.bin) {
    await validateBinPaths(pkg.bin, cwd, save, "bin");
  }

  // Check for unsafe publishing conditions
  // Accept either private: true OR prepublishOnly with "exit 1"
  const hasPublishGuard = pkg.private || pkg.scripts?.prepublishOnly?.includes("exit 1");

  // Only warn if we're not about to fix it with --save
  if (!hasPublishGuard && !save) {
    console.warn("⚠️  WARNING: Root package.json lacks publish protection - this could lead to accidental publishing");
    console.warn("   Run 'libuild build --save' to add publish protection, or manually add a prepublishOnly script");
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

  // Find entry points in both src/ and bin/ directories
  const binDir = Path.join(cwd, "bin");
  const allSrcFiles = await findEntrypoints(srcDir);
  const binEntries = await findBinEntrypoints(binDir);

  // Determine which src files should be entry points
  // This is crucial for code splitting to work correctly
  let srcEntries: string[];

  if (pkg.exports && typeof pkg.exports === 'object') {
    // Check if exports contains multiple src/ entry points beyond "."
    // (we handle "." separately via hasCustomMain check)
    const srcExportKeys = Object.keys(pkg.exports).filter(key => {
      // Skip "." and package.json exports
      if (key === "." || key === "./package.json") return false;
      // Look for exports that reference src/ files (like ./api, ./utils)
      const val = pkg.exports[key];
      if (typeof val === 'string') return val.includes('/src/');
      if (typeof val === 'object' && val !== null) {
        return Object.values(val).some(v => typeof v === 'string' && v.includes('/src/'));
      }
      return false;
    });

    // Check if "." export points to a custom main (not index)
    const dotExport = pkg.exports["."];
    let hasCustomMain = false;
    if (dotExport) {
      const importPath = typeof dotExport === 'string' ? dotExport :
                        (dotExport as any).import || (dotExport as any).default;
      if (importPath && !importPath.includes('/index.')) {
        hasCustomMain = true;
      }
    }

    if (srcExportKeys.length > 0 || hasCustomMain) {
      // Has explicit src exports OR custom main - use all discovered files
      srcEntries = allSrcFiles;
    } else {
      // Only "." export pointing to index, or package.json/bin exports only
      // Use only index for better code splitting
      srcEntries = allSrcFiles.includes("index") ? ["index"] : allSrcFiles;
    }
  } else {
    // No exports field at all - this is likely a multi-entry library
    // Use all discovered files to maintain backward compatibility
    srcEntries = allSrcFiles;
  }
  
  // Combine entries, prefixing bin entries to distinguish them
  const allBinEntries = binEntries.map(entry => ({ name: entry, source: 'top-level' }));
  const entries = [
    ...srcEntries,
    ...allBinEntries.map(entry => `bin/${entry.name}`)
  ];
  
  if (srcEntries.length === 0 && allBinEntries.length === 0) {
    throw new Error("No entry points found in src/ or bin/");
  }
  
  if (allBinEntries.length > 0) {
    console.info(`  Found bin entries: ${allBinEntries.map(entry => entry.name).join(", ")}`);
  }

  const options: BuildOptions = {
    formats: {
      esm: true, // Always build ESM
      cjs: !!pkg.main, // Generate CJS only if main field exists
      umd: entries.includes("umd")
    }
  };

  const mainEntry = detectMainEntry(pkg, srcEntries);

  console.info("  Found entries:", entries.join(", "));
  console.info("  Main entry:", mainEntry);
  if (options.formats.cjs) {
    console.info("  Formats: ESM, CJS" + (options.formats.umd ? ", UMD" : ""));
  } else {
    console.info("  Formats: ESM" + (options.formats.umd ? ", UMD" : "") + " (no main field - CJS disabled)");
  }

  // Clean dist directory atomically using a temporary directory
  const tempDistDir = `${distDir}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Create temporary directory
    await FS.mkdir(tempDistDir, {recursive: true});
    
    // If old dist exists, remove it after we have the temp ready
    if (await fileExists(distDir)) {
      await FS.rm(distDir, {recursive: true});
    }
    
    // Atomically move temp to final location
    await FS.rename(tempDistDir, distDir);
  } catch (error) {
    // Cleanup temp directory if something went wrong
    try {
      if (await fileExists(tempDistDir)) {
        await FS.rm(tempDistDir, {recursive: true});
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }

  // External only JSON files (npm deps handled by packages: "external", Node.js built-ins by platform: "node")
  const externalDeps = [
    "*.json",  // Let Node.js handle JSON imports natively
    "esbuild"  // Explicit external to suppress require.resolve warning from esbuild's own code
  ];

  // Prepare entry points for batch building
  const entryPoints: string[] = [];
  const umdEntries: string[] = [];

  for (const entry of entries) {
    let entryPath: string;
    let jsEntryPath: string;
    let sourceDir: string;
    
    if (entry.startsWith("bin/")) {
      // Handle bin/ entries - need to determine if from top-level bin/ or src/bin/
      const binEntryName = entry.replace("bin/", "");
      const binEntryInfo = allBinEntries.find(binEntry => binEntry.name === binEntryName);
      
      if (binEntryInfo?.source === 'src') {
        // This is a src/bin/ entry
        entryPath = Path.join(srcDir, "bin", `${binEntryName}.ts`);
        jsEntryPath = Path.join(srcDir, "bin", `${binEntryName}.js`);
        sourceDir = "src/bin/";
      } else {
        // This is a top-level bin/ entry
        entryPath = Path.join(binDir, `${binEntryName}.ts`);
        jsEntryPath = Path.join(binDir, `${binEntryName}.js`);
        sourceDir = "bin/";
      }
    } else {
      // Handle src/ entries (existing logic)
      entryPath = Path.join(srcDir, `${entry}.ts`);
      jsEntryPath = Path.join(srcDir, `${entry}.js`);
      sourceDir = "src/";
    }
    
    const actualPath = await fileExists(entryPath) ? entryPath : jsEntryPath;

    if (!await fileExists(actualPath)) {
      throw new Error(`Entry point file not found: ${actualPath}. Expected ${entry.replace("bin/", "")}.ts or ${entry.replace("bin/", "")}.js in ${sourceDir} directory.`);
    }

    if (entry === "umd") {
      umdEntries.push(actualPath);
    } else {
      entryPoints.push(actualPath);
    }
  }

  // Separate src and bin entries for different output directories
  // srcEntryPoints includes regular src/ entries and src/bin/ entries
  const srcEntryPoints = entryPoints.filter(path => path.includes(srcDir));
  // binEntryPoints includes only top-level bin/ entries
  const binEntryPoints = entryPoints.filter(path => path.includes(binDir));
  
  // Create dist/bin directory if needed
  const distBinDir = Path.join(distDir, "bin");
  if (binEntryPoints.length > 0) {
    await FS.mkdir(distBinDir, {recursive: true});
  }

  // Build all regular entries with smart dependency resolution
  if (entryPoints.length > 0) {
    
    // ESM build - build src and bin entries separately to different output directories
    console.info(`  Building ${entryPoints.length} entries (ESM)...`);

    // Get entry point names for external resolution
    const srcEntryNames = srcEntryPoints.map(path => {
      const name = Path.basename(path, Path.extname(path));
      return name;
    });

    const binEntryNames = binEntryPoints.map(path => {
      const name = Path.basename(path, Path.extname(path));
      return name;
    });

    // Build all ESM entries (src + bin) in a single batch
    // Using outbase allows ESBuild to preserve src/ and bin/ directory structure
    const allESMEntryPoints = [...srcEntryPoints, ...binEntryPoints];
    const allEntryNames = [...srcEntryNames, ...binEntryNames];

    if (allESMEntryPoints.length > 0) {
      await ESBuild.build({
        entryPoints: allESMEntryPoints,
        outdir: distDir,
        outbase: cwd, // Preserve src/ and bin/ directory structure
        format: "esm",
        outExtension: {".js": ".js"},
        bundle: true,
        splitting: true, // Enable code splitting for dynamic imports
        minify: false,
        sourcemap: false,
        external: externalDeps,
        platform: "node",
        target: "node18",
        packages: "external",
        supported: { "import-attributes": true },
        plugins: [
          externalEntrypointsPlugin({
            entryNames: allEntryNames,
            outputExtension: ".js"
          }),
          // Generate TypeScript declarations for src entries
          ...(srcEntryPoints.length > 0 ? [dtsPlugin({
            outDir: distSrcDir,
            rootDir: srcDir,
            entryPoints: srcEntryPoints
          })] : []),
          // Generate TypeScript declarations for bin entries
          ...(binEntryPoints.length > 0 ? [dtsPlugin({
            outDir: distBinDir,
            rootDir: binDir,
            entryPoints: binEntryPoints
          })] : [])
        ],
      });

      // Check if code splitting created chunks and warn about CJS incompatibility
      if (options.formats.cjs) {
        // Look for chunk files (files in dist root that aren't entry points)
        const distFiles = await FS.readdir(distDir);
        const chunkFiles = distFiles.filter(f =>
          f.endsWith('.js') &&
          !f.endsWith('.d.ts') &&
          (f.startsWith('chunk-') || f.includes('-') && !f.startsWith('package'))
        );

        if (chunkFiles.length > 0) {
          console.info(`\n⚠️  Code splitting detected - CommonJS build will bundle dynamic imports inline`);
          console.info(`   ESM build: ${chunkFiles.length} chunk file(s) created for lazy loading`);
          console.info(`   CJS build: Dynamic imports bundled inline (no chunks)`);
          console.info(`   To get code splitting benefits, use ESM imports or remove "main" field\n`);
        }
      }

      // Process bin executables for dual runtime support
      if (binEntryPoints.length > 0) {
        const runtimeBanner = generateRuntimeBanner(pkg);
        for (const binEntryName of binEntryNames) {
          const outputPath = Path.join(distBinDir, `${binEntryName}.js`);
          await processJavaScriptExecutable(outputPath, runtimeBanner);
        }
      }
    }

    // CJS build (only if main field exists)
    if (options.formats.cjs) {
      console.info(`  Building ${entryPoints.length} entries (CJS)...`);

      // Build src entries (CJS)
      if (srcEntryPoints.length > 0) {
        try {
          await ESBuild.build({
            entryPoints: srcEntryPoints,
            outdir: distSrcDir,
            format: "cjs",
            outExtension: {".js": ".cjs"},
            bundle: true,
            minify: false,
            sourcemap: false,
            external: externalDeps,
            platform: "node",
            target: "node18",
            supported: { "import-attributes": true },
            plugins: [
              externalEntrypointsPlugin({
                entryNames: srcEntryNames,
                outputExtension: ".cjs"
              })
            ],
          });
        } catch (error: any) {
          // Check if error is due to top-level await
          // ESBuild errors can be in error.message or in error.errors array
          const errorMessage = error.message || '';
          const hasErrorsArray = error.errors && Array.isArray(error.errors);
          const isTLAError = errorMessage.includes('Top-level await is currently not supported with the "cjs" output format') ||
                            (hasErrorsArray && error.errors.some((e: any) =>
                              e.text && e.text.includes('Top-level await is currently not supported with the "cjs" output format')));

          if (isTLAError) {
            console.info(`\n⚠️  Top-level await detected - CommonJS generation disabled`);
            console.info(`   Top-level await is incompatible with CommonJS format`);
            console.info(`   Building ESM-only (Node.js 14+ and modern bundlers supported)`);
            console.info(`   To permanently disable CJS: remove "main" field from package.json\n`);

            // Disable CJS generation for package.json creation
            options.formats.cjs = false;
          } else {
            // Re-throw non-TLA errors
            throw error;
          }
        }
      }

      // Skip CJS build for bin entries - executables only need ESM
    }
  }

  // Build UMD entries separately (they need special plugin handling)
  for (const umdPath of umdEntries) {
    const entry = Path.basename(umdPath, Path.extname(umdPath));
    console.info(`  Building ${entry} (UMD)...`);
    const globalName = pkg.name.includes("/")
      ? pkg.name.split("/").pop()!.replace(/-/g, "").charAt(0).toUpperCase() + pkg.name.split("/").pop()!.replace(/-/g, "").slice(1)
      : pkg.name.replace(/-/g, "").charAt(0).toUpperCase() + pkg.name.replace(/-/g, "").slice(1);

    await ESBuild.build({
      entryPoints: [umdPath],
      outdir: distSrcDir,
      format: "cjs",
      bundle: true,
      minify: false,
      sourcemap: false,
      external: externalDeps,
      platform: "node",
      target: "node18",
      supported: { "import-attributes": true },
      plugins: [umdPlugin({globalName})],
    });
  }

  // TypeScript declarations and triple-slash references are now generated by the TypeScript plugin during ESM build

  // Initialize auto-discovered files tracking
  const autoDiscoveredFiles: string[] = [];

  // Generate package.json
  console.info("  Generating package.json...");
  const cleanedPkg = await cleanPackageJSON(pkg, mainEntry, options, cwd, distDir);
  const exportsResult = await generateExports(entries, mainEntry, options, pkg.exports, distDir, allBinEntries);
  cleanedPkg.exports = fixExportsForDist(exportsResult.exports);

  // Handle stale exports
  if (exportsResult.staleExports.length > 0) {
    console.warn(`⚠️  WARNING: Found ${exportsResult.staleExports.length} stale export(s) pointing to missing src/ files:`);
    for (const staleExport of exportsResult.staleExports) {
      console.warn(`   - ${staleExport}`);
    }
    if (save) {
      console.info("   Removing stale exports from root package.json (--save mode)");
    } else {
      console.warn("   libuild is ZERO-CONFIG - no libuild.config.js file needed!");
      console.warn("   Use 'libuild build --save' to clean up package.json automatically");
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

  // Apply path fixes to the dist package.json
  const fixedDistPkg = fixExportsForDist(cleanedPkg);

  await FS.writeFile(
    Path.join(distDir, "package.json"),
    JSON.stringify(fixedDistPkg, null, 2) + "\n"
  );

  // Copy additional files
  const defaultFilesToCopy = ["README.md", "LICENSE", "CHANGELOG.md"];

  // Copy default files
  for (const file of defaultFilesToCopy) {
    const srcPath = Path.join(cwd, file);
    if (await fileExists(srcPath)) {
      console.info(`  Copying ${file}...`);
      await FS.copyFile(srcPath, Path.join(distDir, file));
    }
  }

  // Copy ambient .d.ts files from src/ to dist/src/
  // These are hand-written type declaration files, not generated by tsc
  if (await fileExists(srcDir)) {
    const srcFiles = await FS.readdir(srcDir);
    const ambientDtsFiles = srcFiles.filter(f => f.endsWith('.d.ts'));

    if (ambientDtsFiles.length > 0) {
      console.info(`  Copying ${ambientDtsFiles.length} ambient .d.ts file(s)...`);
      for (const dtsFile of ambientDtsFiles) {
        const srcPath = Path.join(srcDir, dtsFile);
        const destPath = Path.join(distSrcDir, dtsFile);
        await FS.copyFile(srcPath, destPath);
      }
    }
  }

  // Auto-discover and add common files to files field if files field exists
  const commonFiles = ["README.md", "LICENSE", "CHANGELOG.md", "COPYING", "AUTHORS"];
  if (pkg.files && Array.isArray(pkg.files)) {
    for (const commonFile of commonFiles) {
      const commonPath = Path.join(cwd, commonFile);
      if (await fileExists(commonPath) && !pkg.files.includes(commonFile)) {
        console.info(`  Auto-discovered ${commonFile}, adding to files field...`);
        pkg.files.push(commonFile);
        autoDiscoveredFiles.push(commonFile);
      }
    }
  }

  // Copy files specified in package.json files field
  if (pkg.files && Array.isArray(pkg.files)) {
    console.info("  Copying files from package.json files field...");

    for (const pattern of pkg.files) {
      if (typeof pattern === "string" && (pattern.includes("src") || pattern.includes("dist"))) {
        // Skip src/dist patterns as they're handled by the build process
        continue;
      }

      if (typeof pattern === "string") {
        // Validate the path for security
        const validatedSrcPath = validatePath(pattern, cwd);
        const validatedDestPath = validatePath(pattern, distDir);

        if (await fileExists(validatedSrcPath)) {
          const stat = await FS.stat(validatedSrcPath);
          
          // Check for symlinks and reject them for security
          if (stat.isSymbolicLink()) {
            throw new Error(`Symbolic links are not allowed in files field: ${pattern}`);
          }
          
          if (stat.isDirectory()) {
            console.info(`  Copying directory ${pattern}/...`);
            await FS.mkdir(Path.dirname(validatedDestPath), {recursive: true});
            await FS.cp(validatedSrcPath, validatedDestPath, {recursive: true});
          } else if (stat.isFile()) {
            console.info(`  Copying ${pattern}...`);
            await FS.mkdir(Path.dirname(validatedDestPath), {recursive: true});
            await FS.copyFile(validatedSrcPath, validatedDestPath);
          } else {
            throw new Error(`Unsupported file type for ${pattern}. Only regular files and directories are allowed.`);
          }
        } else if (pattern.includes("*")) {
          const baseDir = pattern.split("*")[0].replace(/\/$/, "");
          if (baseDir) {
            // Validate the base directory path
            const validatedBaseSrcPath = validatePath(baseDir, cwd);
            const validatedBaseDestPath = validatePath(baseDir, distDir);
            
            if (await fileExists(validatedBaseSrcPath)) {
              console.info(`  Copying pattern ${pattern}...`);
              await FS.mkdir(Path.dirname(validatedBaseDestPath), {recursive: true});
              await FS.cp(validatedBaseSrcPath, validatedBaseDestPath, {recursive: true});
            } else {
              throw new Error(`Pattern base directory not found for "${pattern}". Expected directory: ${validatedBaseSrcPath}`);
            }
          } else {
            throw new Error(`Invalid pattern "${pattern}". Pattern must have a base directory before the wildcard.`);
          }
        } else {
          throw new Error(`File specified in files field not found: ${validatedSrcPath}. Remove "${pattern}" from package.json files field or create the file.`);
        }
      } else {
        throw new Error(`Invalid files field entry: ${JSON.stringify(pattern)}. Files field entries must be strings.`);
      }
    }
  }

  if (save) {
    console.info("  Updating root package.json...");
    const rootPkg = {...pkg};

    // Add prepublishOnly guard to prevent accidental publishing from root
    if (!rootPkg.scripts) {
      rootPkg.scripts = {};
    }
    rootPkg.scripts.prepublishOnly = "echo 'ERROR: Cannot publish from root directory. Use libuild publish instead.' && exit 1";

    // Update main/module/types to point to dist
    if (options.formats.cjs) {
      rootPkg.main = `./dist/src/${mainEntry}.cjs`;
    }
    rootPkg.module = `./dist/src/${mainEntry}.js`;
    
    // Only include types field if .d.ts file exists
    const dtsPath = Path.join(distDir, "src", `${mainEntry}.d.ts`);
    if (await fileExists(dtsPath)) {
      rootPkg.types = `./dist/src/${mainEntry}.d.ts`;
    }

    if (rootPkg.typings && typeof rootPkg.typings === "string") {
      rootPkg.typings = rootPkg.typings.startsWith("./dist/") ? rootPkg.typings : "./" + Path.join("dist", rootPkg.typings);
    }

    // Clean up and regenerate exports based on actual built files
    const rootExports: any = {};
    for (const [key, value] of Object.entries(cleanedPkg.exports)) {
      if (typeof value === "string") {
        const distPath = value.startsWith("./dist/") ? value : `./dist${value.startsWith('.') ? value.slice(1) : value}`;
        const fullPath = Path.join(cwd, distPath);
        // Only include if the file actually exists
        if (await fileExists(fullPath)) {
          rootExports[key] = distPath;
        }
      } else if (typeof value === "object" && value !== null) {
        const cleanedValue: any = {};
        let hasValidPaths = false;
        for (const [subKey, subValue] of Object.entries(value)) {
          if (typeof subValue === "string") {
            const distPath = subValue.startsWith("./dist/") ? subValue : `./dist${subValue.startsWith('.') ? subValue.slice(1) : subValue}`;
            const fullPath = Path.join(cwd, distPath);
            // Only include if the file actually exists
            if (await fileExists(fullPath)) {
              cleanedValue[subKey] = distPath;
              hasValidPaths = true;
            }
          }
        }
        // Only include the export if it has at least one valid path
        if (hasValidPaths) {
          rootExports[key] = cleanedValue;
        }
      }
    }
    rootPkg.exports = rootExports;

    // Generate bin entries from discovered bin files
    if (allBinEntries.length > 0) {
      const generatedBin: any = {};
      for (const binEntryInfo of allBinEntries) {
        const binPath = binEntryInfo.source === 'src' 
          ? `./dist/src/bin/${binEntryInfo.name}.js`
          : `./dist/bin/${binEntryInfo.name}.js`;
        const fullPath = Path.join(cwd, binPath);
        // Only add if the file actually exists
        if (await fileExists(fullPath)) {
          generatedBin[binEntryInfo.name] = binPath;
        }
      }
      
      // Merge with existing bin entries or create new bin field
      if (Object.keys(generatedBin).length > 0) {
        if (rootPkg.bin) {
          // Merge with existing bin entries
          if (typeof rootPkg.bin === "string") {
            // Convert single bin entry to object first
            const existingName = pkg.name?.split('/').pop() || 'cli';
            rootPkg.bin = { [existingName]: rootPkg.bin };
          }
          rootPkg.bin = { ...rootPkg.bin, ...generatedBin };
        } else {
          rootPkg.bin = generatedBin;
        }
      }
    }

    // Clean up and validate bin paths based on actual built files
    if (rootPkg.bin) {
      if (typeof rootPkg.bin === "string") {
        const distPath = rootPkg.bin.startsWith("./dist/") ? rootPkg.bin : 
                        rootPkg.bin.startsWith("dist/") ? "./" + rootPkg.bin :
                        "./" + Path.join("dist", rootPkg.bin);
        const fullPath = Path.join(cwd, distPath);
        // Only keep if the file actually exists
        if (await fileExists(fullPath)) {
          rootPkg.bin = distPath;
        } else {
          delete rootPkg.bin;
        }
      } else {
        const cleanedBin: any = {};
        for (const [name, binPath] of Object.entries(rootPkg.bin)) {
          if (typeof binPath === "string") {
            const distPath = binPath.startsWith("./dist/") ? binPath :
                            binPath.startsWith("dist/") ? "./" + binPath :
                            "./" + Path.join("dist", binPath);
            const fullPath = Path.join(cwd, distPath);
            // Only include if the file actually exists
            if (await fileExists(fullPath)) {
              cleanedBin[name] = distPath;
            }
          }
        }
        // Update bin field or remove if no valid entries
        if (Object.keys(cleanedBin).length > 0) {
          rootPkg.bin = cleanedBin;
        } else {
          delete rootPkg.bin;
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
    console.info("  Skipping root package.json update (use --save to enable)");
  }

  console.info("\nBuild complete!");

  // Show summary
  console.info(`\n  Output: ${distDir}`);
  console.info(`\n  Entries: ${entries.length}`);
  if (options.formats.cjs) {
    console.info(`\n  Formats: ESM, CJS${options.formats.umd ? ", UMD" : ""}`);
  } else {
    console.info(`\n  Formats: ESM${options.formats.umd ? ", UMD" : ""}`);
  }

  // Create rootPkg based on whether --save was used
  let rootPkg = pkg;
  if (save) {
    // rootPkg was already created and saved above
    rootPkg = JSON.parse(await FS.readFile(pkgPath, "utf-8")) as PackageJSON;
  }

  // Set executable permissions and dual runtime shebang for bin files
  if (allBinEntries.length > 0 || fixedDistPkg.bin) {
    const runtimeBanner = generateRuntimeBanner(pkg);
    await makeFilesExecutable(fixedDistPkg, cwd, allBinEntries, runtimeBanner);
  }

  return {distPkg: fixedDistPkg, rootPkg};
}

export async function publish(cwd: string, save: boolean = true, extraArgs: string[] = []) {
  await build(cwd, save);

  console.info("\nPublishing to npm...");

  const distDir = Path.join(cwd, "dist");
  const distPkgPath = Path.join(distDir, "package.json");

  if (!await fileExists(distPkgPath)) {
    throw new Error("No dist/package.json found. Run 'libuild build' first.");
  }

  // Read the package.json to check if it's a scoped package
  const distPkg = JSON.parse(await FS.readFile(distPkgPath, "utf-8")) as PackageJSON;

  // Run npm publish in dist directory
  // Note: If package has private: true, npm will reject the publish
  const publishArgs = ["publish"];
  if (distPkg.name.startsWith("@")) {
    publishArgs.push("--access", "public");
  }
  
  // Add any extra arguments passed from CLI
  publishArgs.push(...extraArgs);

  const proc = spawn("npm", publishArgs, {
    cwd: distDir,
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolve) => {
    proc.on("close", resolve);
  });

  if (exitCode === 0) {
    const distPkg = JSON.parse(await FS.readFile(distPkgPath, "utf-8")) as PackageJSON;
    console.info(`\nPublished ${distPkg.name}@${distPkg.version}!`);
  } else {
    throw new Error("npm publish failed");
  }
}
