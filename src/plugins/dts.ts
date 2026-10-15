import * as FS from "fs/promises";
import * as fsSync from "fs";
import * as Path from "path";
import { pathToFileURL } from "url";
import * as ESBuild from "esbuild";
import type TS from "typescript";

export interface TypeScriptPluginOptions {
  tsConfigPath?: string;
  outDir: string;
  rootDir: string;
  entryPoints: string[];
}

// libuild's ambient declaration of import.meta.litest, beside this module in
// the source layout (src/litest.d.ts) and at the package root in the published
// one (dist/litest.d.ts), where this code runs from cli.js or a chunk.
function litestDeclarationPath(): string | null {
  for (const relative of ["../litest.d.ts", "./litest.d.ts", "../../litest.d.ts"]) {
    const candidate = new URL(relative, import.meta.url);
    if (candidate.protocol === "file:") {
      const path = decodeURIComponent(candidate.pathname);
      try {
        if (fsSync.statSync(path).isFile()) return path;
      } catch {}
    }
  }
  return null;
}

/**
 * The tsconfig nearest to the source directory: its compiler options and its
 * whole file list. The program has to hold the same files `tsc -p` does, not
 * just the bundle's: a .d.ts is never a bundle input, so a project's own
 * `declare module "untyped"` would be missing, and since TypeScript 6 no
 * @types package loads on its own - a project gets @types/node only because
 * some file in its tsconfig references it, often a test.
 */
function projectConfig(TS: typeof import("typescript"), rootDir: string): { options: TS.CompilerOptions; files: string[] } {
  const none = { options: {}, files: [] };
  const configPath = TS.findConfigFile(rootDir, TS.sys.fileExists);
  if (!configPath) return none;
  const configFile = TS.readConfigFile(configPath, TS.sys.readFile);
  if (configFile.error) return none;
  const parsed = TS.parseJsonConfigFileContent(configFile.config, TS.sys, Path.dirname(configPath), undefined, configPath);
  return { options: parsed.options, files: parsed.fileNames };
}

/**
 * The project's TypeScript, the one its own `tsc` runs; libuild's only when
 * the project has none. Judging a project with a different compiler version
 * reports errors its tsc does not - 925 of them for termdom on 6.0 under 5.9.
 *
 * Found by walking up for a real node_modules/typescript rather than with
 * createRequire: under bun, a failed resolve falls through to bun's global
 * install cache. And only a module with the compiler API counts - TypeScript
 * 7's native port ships none.
 */
async function projectTypeScript(rootDir: string): Promise<typeof import("typescript")> {
  const usable = (mod: any) => {
    const ts = mod?.default ?? mod;
    return ts && typeof ts.createProgram === "function" ? ts : null;
  };
  for (let dir = Path.resolve(rootDir); ; dir = Path.dirname(dir)) {
    const pkgDir = Path.join(dir, "node_modules", "typescript");
    const pkgJson = Path.join(pkgDir, "package.json");
    if (fsSync.existsSync(pkgJson)) {
      const main = JSON.parse(fsSync.readFileSync(pkgJson, "utf-8")).main ?? "index.js";
      const ts = usable(await import(pathToFileURL(Path.join(pkgDir, main)).href).catch(() => null));
      if (ts) return ts;
      break;
    }
    if (dir === Path.dirname(dir)) break;
  }
  const ts = usable(await import("typescript"));
  if (!ts) throw new Error("No TypeScript with a compiler API is available");
  return ts;
}

/** Whether a TypeScript compiler can be found for the project, so declarations are expected. */
export async function typeScriptAvailable(rootDir: string): Promise<boolean> {
  try {
    await projectTypeScript(rootDir);
    return true;
  } catch {
    return false;
  }
}

export function dtsPlugin(options: TypeScriptPluginOptions): ESBuild.Plugin {
  return {
    name: "dts",
    setup(build) {
      const entryFiles: string[] = [];

      // Collect TypeScript files during the build
      build.onLoad({filter: /\.tsx?$/}, async (args) => {
        if (!entryFiles.includes(args.path)) {
          entryFiles.push(args.path);
        }
        return undefined; // Let esbuild handle the file normally
      });

      // Generate declarations after build
      build.onEnd(async (result) => {
        if (result.errors.length > 0) {
          return; // Don't generate declarations if there are errors
        }

        // Try to import TypeScript
        let TS: typeof import("typescript");
const immutableSourceFiles = new Map<string, any>();

// -----------------------------------------------------------------------------
// Immutable declaration inputs - TypeScript's own lib files and node_modules
// types - parsed ONCE per process instead of once per createProgram. Every
// build was re-parsing lib.d.ts and the dependency tree from scratch; in
// libuild's own suite that meant 136 fresh programs each paying the full parse
// cost, which dominated the suite's compute. Fixture/source files are never
// cached (they change per build); SourceFile objects are immutable, and every
// program here uses identical compiler options, so sharing is safe.
// -----------------------------------------------------------------------------
        try {
          TS = await projectTypeScript(options.rootDir);
        } catch (error) {
          // TypeScript not available - skip .d.ts generation
          return;
        }

        // Ensure output directory exists
        await FS.mkdir(options.outDir, { recursive: true });

        // Resolve symlinks in paths to ensure consistency
        // (e.g., /tmp -> /private/tmp on macOS)
        const fs = await import("fs");
        const resolvedRootDir = fs.realpathSync(options.rootDir);
        const resolvedOutDir = fs.realpathSync(options.outDir);

        // Collect all TypeScript files for declaration generation
        // This includes internal modules so their .d.ts files are generated
        // Filter to only files within rootDir to prevent emitting .d.ts to wrong locations
        // onLoad sees only the files no earlier plugin claimed - a plugin that
        // returns contents (the litest strip) hides its files from every onLoad
        // after it, and a source file using import.meta.litest shipped with no
        // declaration that way. The metafile lists every input regardless.
        const absWorkingDir = build.initialOptions.absWorkingDir ?? process.cwd();
        const inputs = Object.keys(result.metafile?.inputs ?? {}).map((input) => Path.resolve(absWorkingDir, input));
        const tsFiles = [...new Set([...entryFiles, ...inputs])]
          .filter(file => (file.endsWith('.ts') || file.endsWith('.tsx')) && !file.endsWith('.d.ts'))
          .filter(file => !file.includes(`${Path.sep}node_modules${Path.sep}`))
          .map(f => fs.realpathSync(f))
          .filter(f => f.startsWith(resolvedRootDir + Path.sep));

        if (tsFiles.length === 0) {
          return;
        }

        const resolvedTsFiles = tsFiles;

        try {
          // Start from the project's own tsconfig, so the program judges the
          // project the way `tsc -p .` does - its lib, types, module settings,
          // allowImportingTsExtensions, paths - and override only what emitting
          // declarations into the flat layout needs. Without it, a project
          // clean under tsc drew a wall of false errors here.
          const project = projectConfig(TS, resolvedRootDir);
          const compilerOptions: TS.CompilerOptions = {
            ...project.options,
            declaration: true,
            emitDeclarationOnly: true,
            noEmit: false,
            noEmitOnError: false,
            outDir: resolvedOutDir,
            rootDir: resolvedRootDir,
            declarationDir: undefined,
            composite: false,
            incremental: false,
            tsBuildInfoFile: undefined,
            skipLibCheck: true,
          };
          compilerOptions.esModuleInterop ??= true;
          compilerOptions.target ??= TS.ScriptTarget.ES2020;
          compilerOptions.module ??= TS.ModuleKind.ESNext;
          compilerOptions.moduleResolution ??= TS.ModuleResolutionKind.Bundler;

          // .tsx entries need a jsx setting to parse; preserve needs no
          // runtime resolution.
          if (tsFiles.some(f => f.endsWith('.tsx'))) {
            compilerOptions.jsx ??= TS.JsxEmit.Preserve;
          }

          // Create program with explicit config to avoid tsconfig.json
          // interference, on a host that reuses parsed immutable inputs.
          const host = TS.createCompilerHost(compilerOptions);
          const realGetSourceFile = host.getSourceFile.bind(host);
          host.getSourceFile = (fileName: string, languageVersion: any, ...rest: any[]) => {
            const immutable = fileName.includes(`${Path.sep}node_modules${Path.sep}`) ||
              /[\\/]typescript[\\/]lib[\\/]/.test(fileName);
            if (!immutable) return realGetSourceFile(fileName, languageVersion, ...rest);
            // A parse depends on the compiler and the language settings, which
            // now differ by project, so both are part of the key.
            const key = `${TS.version}\0${JSON.stringify(languageVersion)}\0${fileName}`;
            let cached = immutableSourceFiles.get(key);
            if (!cached) {
              cached = realGetSourceFile(fileName, languageVersion, ...rest);
              if (cached) immutableSourceFiles.set(key, cached);
            }
            return cached;
          };
          // import.meta.litest is legal in any source file, so the program is
          // told its type by libuild's own ambient declaration. It emits
          // nothing: a .d.ts root produces no output.
          const litestTypes = litestDeclarationPath();
          const rootFiles = [...new Set([...resolvedTsFiles, ...project.files, ...(litestTypes ? [litestTypes] : [])])];
          const program = TS.createProgram(rootFiles, compilerOptions, host);

          // tsc writes declarations despite type errors, and so does this; but
          // an error here is otherwise invisible, since nothing type-checks
          // the project in a build. Say so, naming the file and the error.
          // Only files under the source directory: tests and scripts are in the
          // program so it sees what tsc sees, and their own errors are not the
          // build's to report. Per file, so program-wide diagnostics - a test
          // lying outside rootDir - are not reported either.
          const typeErrors = program.getSourceFiles()
            .filter((sf) => fs.realpathSync(sf.fileName).startsWith(resolvedRootDir + Path.sep))
            .flatMap((sf) => [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)])
            .filter((d) => d.category === TS.DiagnosticCategory.Error);
          if (typeErrors.length > 0) {
            const text = TS.formatDiagnosticsWithColorAndContext(typeErrors, {
              getCanonicalFileName: path => path,
              getCurrentDirectory: () => process.cwd(),
              getNewLine: () => '\n'
            });
            result.warnings.push({
              id: "typescript-type-errors",
              pluginName: "dts",
              text: `TypeScript reported ${typeErrors.length} error(s) while generating declarations (declarations were still written):\n${text}`,
              location: null,
              notes: [],
              detail: undefined
            });
          }

          // Custom writeFile to prevent emitting .d.ts files outside outDir
          // This can happen when files import from outside rootDir (e.g., bin importing from src)
          const writeFile: TS.WriteFileCallback = (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
            // Only write files that would go into the outDir
            if (!fileName.startsWith(resolvedOutDir + Path.sep)) {
              return; // Skip files outside outDir
            }
            TS.sys.writeFile(fileName, data, writeByteOrderMark);
          };

          // Declarations for the bundle's files only; the rest of the program
          // is there to be seen, not emitted.
          const emitDiagnostics = resolvedTsFiles.flatMap((file) => {
            const sourceFile = program.getSourceFile(file);
            return sourceFile ? program.emit(sourceFile, writeFile).diagnostics : [];
          });

          if (emitDiagnostics.length > 0) {
            const diagnostics = TS.formatDiagnosticsWithColorAndContext(emitDiagnostics, {
              getCanonicalFileName: path => path,
              getCurrentDirectory: () => process.cwd(),
              getNewLine: () => '\n'
            });

            result.errors.push({
              id: "typescript-declarations",
              pluginName: "dts",
              text: `TypeScript declaration generation failed:\n${diagnostics}`,
              location: null,
              notes: [],
              detail: undefined
            });
          }
        } catch (error: any) {
          result.errors.push({
            id: "typescript-plugin-error",
            pluginName: "dts",
            text: `TypeScript plugin error: ${error.message}`,
            location: null,
            notes: [],
            detail: undefined
          });
        }

        // Add triple-slash references to JS files for Deno compatibility
        await addTripleSlashReferences(resolvedTsFiles, resolvedOutDir, resolvedRootDir);

        // Add triple-slash references to ambient .d.ts files in generated .d.ts files
        await addAmbientReferences(resolvedTsFiles, resolvedOutDir, resolvedRootDir);
      });
    }
  };
}

async function addTripleSlashReferences(tsFiles: string[], outDir: string, rootDir: string) {
  for (const tsFile of tsFiles) {
    // Get relative path from rootDir to preserve directory structure
    const relativePath = Path.relative(rootDir, tsFile);
    const relativeDir = Path.dirname(relativePath);
    const baseName = Path.basename(tsFile, Path.extname(tsFile));

    // Build paths preserving subdirectory structure
    const outputSubDir = relativeDir === '.' ? outDir : Path.join(outDir, relativeDir);
    const jsPath = Path.join(outputSubDir, `${baseName}.js`);
    const dtsPath = Path.join(outputSubDir, `${baseName}.d.ts`);

    // Only add reference if both files exist
    const [jsExists, dtsExists] = await Promise.all([
      FS.access(jsPath).then(() => true).catch(() => false),
      FS.access(dtsPath).then(() => true).catch(() => false)
    ]);

    if (!jsExists || !dtsExists) continue;

    const content = await FS.readFile(jsPath, "utf-8");
    const referenceComment = `/// <reference types="./${baseName}.d.ts" />`;

    let modifiedContent: string;
    // Check if file starts with shebang
    if (content.startsWith("#!")) {
      const firstNewline = content.indexOf("\n");
      if (firstNewline !== -1) {
        modifiedContent = content.slice(0, firstNewline + 1) +
                         `${referenceComment}\n` +
                         content.slice(firstNewline + 1);
      } else {
        modifiedContent = content + `\n${referenceComment}`;
      }
    } else {
      modifiedContent = `${referenceComment}\n${content}`;
    }

    // Write the modified content
    await FS.writeFile(jsPath, modifiedContent);
  }
}

async function addAmbientReferences(tsFiles: string[], outDir: string, rootDir: string) {
  // Find all ambient .d.ts files in the source directory
  // rootDir is already pointing to the src/ directory
  let ambientFiles: string[] = [];

  try {
    const files = await FS.readdir(rootDir);
    ambientFiles = files.filter(f => f.endsWith('.d.ts'));
  } catch {
    // Directory doesn't exist or can't be read
    return;
  }

  if (ambientFiles.length === 0) return;

  // Add references to each generated .d.ts file
  for (const tsFile of tsFiles) {
    // Get relative path from rootDir to preserve directory structure
    const relativePath = Path.relative(rootDir, tsFile);
    const relativeDir = Path.dirname(relativePath);
    const baseName = Path.basename(tsFile, Path.extname(tsFile));

    // Build paths preserving subdirectory structure
    const outputSubDir = relativeDir === '.' ? outDir : Path.join(outDir, relativeDir);
    const dtsPath = Path.join(outputSubDir, `${baseName}.d.ts`);

    const dtsExists = await FS.access(dtsPath).then(() => true).catch(() => false);
    if (!dtsExists) continue;

    const content = await FS.readFile(dtsPath, "utf-8");

    // Calculate relative path from this .d.ts file back to the ambient files in root
    const relativeToRoot = relativeDir === '.' ? './' : '../'.repeat(relativeDir.split(Path.sep).length);

    // Generate triple-slash reference directives for each ambient file
    const references = ambientFiles
      .map(ambientFile => `/// <reference path="${relativeToRoot}${ambientFile}" />`)
      .join('\n');

    // Prepend references to the generated .d.ts file
    const modifiedContent = `${references}\n${content}`;
    await FS.writeFile(dtsPath, modifiedContent);
  }
}


