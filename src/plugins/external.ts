import * as ESBuild from "esbuild";

export interface ExternalEntrypointsOptions {
  entryNames: string[];
  currentEntry?: string; // Optional for batch builds
  outputExtension: string;
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

      // Mark cross-directory entry points as external (../src/foo, ../bin/bar)
      build.onResolve({filter: /^\.\.\/(?:src|bin)\//}, args => {
        const withoutExt = args.path.replace(/\.(ts|js)$/, '');
        // Extract just the filename from paths like ../src/index or ../bin/cli
        const match = withoutExt.match(/^\.\.\/(?:src|bin)\/(.+)$/);
        if (match) {
          const entryName = match[1];
          if (externalEntries.includes(entryName)) {
            // Preserve the directory structure in the external path
            const dir = withoutExt.match(/^(\.\.\/(?:src|bin))\//)?.[1];
            return {
              path: `${dir}/${entryName}${outputExtension}`,
              external: true
            };
          }
        }
      });
    }
  };
}
