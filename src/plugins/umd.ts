import * as FS from "fs/promises";
import * as Path from "path";

interface UMDPluginOptions {
  globalName: string;
}

export function umdPlugin(options: UMDPluginOptions) {
  return {
    name: "umd",
    setup(build: any) {
      build.onEnd(async (result: any) => {
        if (result.errors.length > 0) return;

        // ESBuild doesn't provide outputFiles by default unless write: false
        // We need to find the generated files in the output directory
        const outputDir = build.initialOptions.outdir;
        if (outputDir) {
          const files = await FS.readdir(outputDir);
          for (const file of files) {
            if (file.endsWith(".js") && !file.endsWith(".js.map")) {
              await wrapWithUMD(Path.join(outputDir, file), options.globalName);
            }
          }
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
