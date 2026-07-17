import * as FS from "fs/promises";

interface UMDPluginOptions {
  globalName: string;
}

export function umdPlugin(options: UMDPluginOptions) {
  return {
    name: "umd",
    setup(build: any) {
      build.onEnd(async (result: any) => {
        if (result.errors.length > 0) return;

        // Wrap ONLY the UMD output file. Scanning the whole outdir would wrap
        // (and corrupt) sibling ESM entry files that share the directory.
        const outfile = build.initialOptions.outfile;
        if (outfile) {
          await wrapWithUMD(outfile, options.globalName);
        }
      });
    },
  };
}

async function wrapWithUMD(filePath: string, globalName: string) {
  const code = await FS.readFile(filePath, "utf-8");

  // Replace module.exports with return
  let modifiedCode = code.replace(/\nmodule\.exports\s*=\s*([^;]+);?\s*$/, '\nreturn $1;');

  // UMD wrapper
  const umdHeader = `(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    // CommonJS
    module.exports = factory();
  } else {
    // Browser globals
    root.${globalName} = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
`;

  const umdFooter = `
}));`;

  // Wrap with UMD
  const result = umdHeader + modifiedCode + umdFooter;

  await FS.writeFile(filePath, result);
}
