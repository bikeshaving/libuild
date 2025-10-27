import * as ESBuild from "esbuild";

export interface ExternalEntrypointsOptions {
  entryNames: string[];
  currentEntry: string;
  outputExtension: string;
}

export function externalEntrypointsPlugin(options: ExternalEntrypointsOptions): ESBuild.Plugin {
  return {
    name: "external-entrypoints",
    setup(build) {
      const {entryNames, currentEntry, outputExtension} = options;
      const otherEntries = entryNames.filter(name => name !== currentEntry);

      // Mark other entry points as external and transform extensions
      build.onResolve({filter: /^\.\//}, args => {
        const withoutExt = args.path.replace(/\.(ts|js)$/, '');
        const entryName = withoutExt.replace(/^\.\//, '');

        if (otherEntries.includes(entryName)) {
          return {
            path: `./${entryName}${outputExtension}`,
            external: true
          };
        }
      });
    }
  };
}
