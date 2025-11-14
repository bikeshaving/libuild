import * as ESBuild from "esbuild";

export interface ExternalEntrypointsOptions {
  entryNames: string[];
  currentEntry?: string; // Optional for batch builds
  outputExtension: string;
  srcEntryNames?: string[]; // For externalizing src imports from bin
}

export function externalEntrypointsPlugin(options: ExternalEntrypointsOptions): ESBuild.Plugin {
  return {
    name: "external-entrypoints",
    setup(build) {
      const {entryNames, currentEntry, outputExtension, srcEntryNames} = options;

      // For batch builds (no currentEntry), make all entries external to each other
      // For individual builds, exclude only the current entry
      const externalEntries = currentEntry
        ? entryNames.filter(name => name !== currentEntry)
        : entryNames;

      // Mark entry points as external and transform extensions
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

      // Handle cross-directory imports (e.g., bin importing from ../src/)
      if (srcEntryNames && srcEntryNames.length > 0) {
        build.onResolve({filter: /^\.\.\/src\//}, args => {
          const withoutExt = args.path.replace(/\.(ts|js)$/, '');
          const entryName = withoutExt.replace(/^\.\.\/src\//, '');

          if (srcEntryNames.includes(entryName)) {
            return {
              path: `../src/${entryName}${outputExtension}`,
              external: true
            };
          }
        });
      }
    }
  };
}
