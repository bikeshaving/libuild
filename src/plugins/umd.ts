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

  // The factory body is esbuild format:"cjs" output, which assigns to
  // module.exports internally (module.exports = __toCommonJS(...)) and
  // returns nothing. Give the factory its own CommonJS shim and return it:
  // in the browser there is no `module` global to clobber (or throw on),
  // and in CJS the wrapper's `module.exports = factory()` gets the real
  // exports instead of undefined.
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
'use strict';
var module = { exports: {} };
var exports = module.exports;
`;

  const umdFooter = `
return module.exports;
}));`;

  await FS.writeFile(filePath, umdHeader + code + umdFooter);
}
