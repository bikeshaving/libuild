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
        } catch {
          // TypeScript not available - skip .d.ts generation
          return;
        }

        // Only generate declarations for actual entry points, not internal modules
        const tsFiles = entryFiles.filter(file => {
          if (!file.endsWith('.ts')) return false;

          // Check if this file matches any of the entry points
          return options.entryPoints.some(entryPoint => {
            const normalizedEntry = Path.resolve(entryPoint);
            const normalizedFile = Path.resolve(file);
            return normalizedEntry === normalizedFile;
          });
        });
        if (tsFiles.length === 0) {
          return;
        }

        try {
          const compilerOptions: TS.CompilerOptions = {
            declaration: true,
            emitDeclarationOnly: true,
            outDir: options.outDir,
            rootDir: options.rootDir,
            skipLibCheck: true,
            esModuleInterop: true,
            target: TS.ScriptTarget.ES2020,
            module: TS.ModuleKind.ESNext,
            isolatedModules: true, // Prevent cross-file type dependencies
            noResolve: true, // Don't resolve imports - only process the specific files
          };

          // Create program with explicit config to avoid tsconfig.json interference
          const program = TS.createProgram(tsFiles, compilerOptions);
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
        await addTripleSlashReferences(tsFiles, options.outDir);
      });
    }
  };
}

async function addTripleSlashReferences(tsFiles: string[], outDir: string) {
  for (const tsFile of tsFiles) {
    const baseName = Path.basename(tsFile, Path.extname(tsFile));
    const jsPath = Path.join(outDir, `${baseName}.js`);
    const dtsPath = Path.join(outDir, `${baseName}.d.ts`);

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


