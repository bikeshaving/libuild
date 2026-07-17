import * as ESBuild from "esbuild";

export interface ExternalEntrypointsOptions {
  entryNames: string[];
  currentEntry?: string; // Optional for batch builds
  outputExtension: string;
}

// Output layout (flat):
//   src/<entry>      -> <entry>        (dist root)
//   src/bin/<entry>  -> bin/<entry>
//   bin/<entry>      -> bin/<entry>
// Import rewrites must account for the importer's OUTPUT location, which no
// longer mirrors its source location for src/ files.
function importerOutputDir(importer: string): "root" | "bin" {
  // src/bin/x.ts and bin/x.ts both output to dist/bin/
  if (/[/\\](?:src[/\\])?bin[/\\][^/\\]+$/.test(importer)) {
    return "bin";
  }
  return "root";
}

export function externalEntrypointsPlugin(options: ExternalEntrypointsOptions): ESBuild.Plugin {
  return {
    name: "external-entrypoints",
    setup(build) {
      const {entryNames, currentEntry, outputExtension} = options;

      // For batch builds (no currentEntry), make all entries external to each other
      // For individual builds, exclude only the current entry
      const externalEntries = currentEntry
        ? entryNames.filter(name => name !== currentEntry)
        : entryNames;

      // Mark same-directory entry points as external (./foo, ./bar)
      // Same source directory means same output directory in the flat layout,
      // so the relative path is unchanged.
      build.onResolve({filter: /^\.\//}, args => {
        const withoutExt = args.path.replace(/\.(ts|js)$/, '');
        const entryName = withoutExt.replace(/^\.\//, '');

        if (externalEntries.includes(entryName)) {
          return {
            path: `./${entryName}${outputExtension}`,
            external: true
          };
        }
      });

      // Mark cross-directory ENTRY POINT imports as external (../src/foo, ../bin/bar)
      // Only externalize if the imported file is an actual entry point
      build.onResolve({filter: /^\.\.\/(?:src|bin)\//}, args => {
        const withoutExt = args.path.replace(/\.(ts|js)$/, '');
        const match = withoutExt.match(/^\.\.\/(src|bin)\/(.+)$/);
        if (match) {
          const dir = match[1];
          const entryName = match[2];
          if (externalEntries.includes(entryName)) {
            // Compute the output-relative path in the flat layout
            const importerDir = importerOutputDir(args.importer);
            let outPath: string;
            if (dir === "src") {
              // Target src entry outputs to dist root.
              // ../src/foo can only be written from a directory below root
              // (top-level bin/), whose output is dist/bin/ -> one level up.
              outPath = importerDir === "bin"
                ? `../${entryName}${outputExtension}`
                : `./${entryName}${outputExtension}`;
            } else {
              // Target bin entry outputs to dist/bin/.
              // ../bin/foo from src/x.ts (output: root) -> ./bin/foo
              // ../bin/foo from src/bin/x.ts (resolves to a sibling) -> ./foo
              outPath = importerDir === "bin"
                ? `./${entryName}${outputExtension}`
                : `./bin/${entryName}${outputExtension}`;
            }
            return {
              path: outPath,
              external: true
            };
          }
        }
        // Not an entry point, let it be bundled
        return undefined;
      });
    }
  };
}
