import * as FS from "fs/promises";
import * as Path from "path";
import * as ESBuild from "esbuild";
import type TS from "typescript";

export interface TypeScriptPluginOptions {
  tsConfigPath?: string;
  outDir: string;
  rootDir: string;
  entryPoints: string[];
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
        try {
          TS = await import("typescript");
        } catch (error) {
          // TypeScript not available - skip .d.ts generation
          return;
        }

        // Collect all TypeScript files for declaration generation
        // This includes internal modules so their .d.ts files are generated
        const tsFiles = entryFiles.filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'));
        if (tsFiles.length === 0) {
          return;
        }

        // Ensure output directory exists
        await FS.mkdir(options.outDir, { recursive: true });

        // Resolve symlinks in paths to ensure consistency
        // (e.g., /tmp -> /private/tmp on macOS)
        const fs = await import("fs");
        const resolvedRootDir = fs.realpathSync(options.rootDir);
        const resolvedOutDir = fs.realpathSync(options.outDir);
        // Also resolve tsFiles paths to match rootDir/outDir
        const resolvedTsFiles = tsFiles.map(f => fs.realpathSync(f));

        try {
          const compilerOptions: TS.CompilerOptions = {
            declaration: true,
            emitDeclarationOnly: true,
            outDir: resolvedOutDir,
            rootDir: resolvedRootDir,
            skipLibCheck: true,
            esModuleInterop: true,
            target: TS.ScriptTarget.ES2020,
            module: TS.ModuleKind.ESNext,
            moduleResolution: TS.ModuleResolutionKind.Bundler,
          };

          // Create program with explicit config to avoid tsconfig.json interference
          const program = TS.createProgram(resolvedTsFiles, compilerOptions);
          const emitResult = program.emit();

          if (emitResult.diagnostics.length > 0) {
            const diagnostics = TS.formatDiagnosticsWithColorAndContext(emitResult.diagnostics, {
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


