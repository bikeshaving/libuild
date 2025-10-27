import * as FS from "fs/promises";
import * as Path from "path";
import * as ESBuild from "esbuild";
import TS from "typescript";

export interface TypeScriptPluginOptions {
  tsConfigPath?: string;
  outDir: string;
  rootDir: string;
  entryPoints: string[];
}

export function typescriptPlugin(options: TypeScriptPluginOptions): ESBuild.Plugin {
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
      });
    }
  };
}
