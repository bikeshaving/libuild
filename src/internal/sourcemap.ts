import * as FS from "fs/promises";
import * as Path from "path";

/**
 * Lines added to the top of a built file after esbuild wrote it - a
 * shebang, a types reference, a UMD header - move every line of code down,
 * so its source map has to move by the same count.
 */
export async function shiftSourceMap(jsPath: string, lines: number): Promise<void> {
  if (lines <= 0) return;
  const mapPath = `${jsPath}.map`;
  const text = await FS.readFile(mapPath, "utf-8").catch(() => null);
  if (text === null) return;
  const map = JSON.parse(text);
  map.mappings = ";".repeat(lines) + map.mappings;
  await FS.writeFile(mapPath, JSON.stringify(map));
}

export function addedLines(before: string, after: string): number {
  return after.split("\n").length - before.split("\n").length;
}

/**
 * dist/ is the package root once published, so a source named relative to
 * the project - "../src/x.ts" - points outside the package, and a consumer's
 * stack trace reads node_modules/src/x.ts with the package name gone. Name
 * each source as if the project were dist/: node_modules/<pkg>/src/x.ts.
 */
export async function rootSourcesInDist(distDir: string): Promise<void> {
  const realDist = await FS.realpath(distDir).catch(() => null);
  if (realDist === null) return;
  const projectDir = Path.dirname(realDist);
  const entries = await FS.readdir(distDir, {recursive: true});
  for (const entry of entries) {
    if (!entry.endsWith(".map") || entry.split(Path.sep).includes("node_modules")) continue;
    const mapPath = Path.join(distDir, entry);
    const map = JSON.parse(await FS.readFile(mapPath, "utf-8"));
    map.sources = await Promise.all(map.sources.map(async (source: string) => {
      const resolved = Path.resolve(Path.dirname(mapPath), source);
      const real = await FS.realpath(resolved).catch(() => resolved);
      const inDist = Path.join(realDist, Path.relative(projectDir, real));
      return Path.relative(Path.dirname(Path.join(realDist, entry)), inDist).split(Path.sep).join("/");
    }));
    await FS.writeFile(mapPath, JSON.stringify(map));
  }
}
