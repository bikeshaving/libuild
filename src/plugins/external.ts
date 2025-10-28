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
    }
  };
}
