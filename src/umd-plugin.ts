import * as FS from "fs/promises";
import * as Path from "path";
import MagicString from "magic-string";

interface UmdPluginOptions {
  globalName: string;
}

export function umdPlugin(options: UmdPluginOptions) {
  return {
    name: "umd-wrapper",
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
              await wrapWithUmd(Path.join(outputDir, file), options.globalName);
            }
          }
        }
      });
    },
  };
}

async function wrapWithUmd(filePath: string, globalName: string) {
  const code = await FS.readFile(filePath, "utf-8");
  const ms = new MagicString(code);

  // Remove sourcemap comment
  const sourcemapComment = code.match(/\/\/# sourceMappingURL=.+$/m);
  if (sourcemapComment) {
    const index = code.lastIndexOf(sourcemapComment[0]);
    ms.remove(index, index + sourcemapComment[0].length);
  }

  // Replace module.exports with return
  const exportsMatch = code.match(/\nmodule\.exports\s*=\s*([^;]+);?\s*$/);
  if (exportsMatch) {
    const index = code.lastIndexOf(exportsMatch[0]);
    ms.overwrite(index, index + exportsMatch[0].length, `\nreturn ${exportsMatch[1]};`);
  }

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
  ms.prepend(umdHeader);
  ms.append(umdFooter);

  // Generate sourcemap and write files
  const result = ms.toString();
  const map = ms.generateMap({
    file: Path.basename(filePath),
    source: Path.basename(filePath).replace(".js", ".ts"),
    includeContent: true,
  });

  await FS.writeFile(filePath, result);
  await FS.writeFile(filePath + ".map", map.toString());
  await FS.writeFile(filePath, result + `\n//# sourceMappingURL=${Path.basename(filePath)}.map`);
}
