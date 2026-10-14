import {test, expect} from "../src/test.ts";
import * as FS from "fs/promises";
import * as FSSync from "fs";
import * as Path from "path";
import {createRequire} from "module";
import {createTempDir, removeTempDir} from "./test-utils.ts";
import {watchTests, type WatchApp} from "../src/internal/watch.ts";

const termdomDir = (() => {
  try {
    return Path.dirname(createRequire(import.meta.url).resolve("@b9g/termdom/package.json"));
  } catch {
    return null;
  }
})();

// A terminal that answers nothing: termdom's negotiations time out on their
// own and the first frame still lands. Keys go in through `press`.
function fakeTerminal(): {transport: unknown; press(keys: string): Promise<void>; screen(): string} {
  let output = "";
  let push!: (text: string) => void;
  const transport = {
    cols: 100,
    rows: 30,
    readable: new ReadableStream<string>({start(controller) { push = (text) => controller.enqueue(text); }}),
    writable: new WritableStream<string>({write(chunk) { output += String(chunk); }}),
    resizes: new ReadableStream({start() {}}),
    sharesScreen: false,
    interactive: true,
    ready: Promise.resolve(),
    closed: new Promise(() => {}),
    close() {},
  };
  return {
    transport,
    async press(keys) { push(keys); await new Promise((r) => setTimeout(r, 20)); },
    screen: () => output,
  };
}

async function fixture(): Promise<{testDir: string; projDir: string; runs(name: string): number}> {
  const testDir = await createTempDir("watch");
  const projDir = Path.join(testDir, "proj");
  await FS.mkdir(Path.join(projDir, "src"), {recursive: true});
  await FS.mkdir(Path.join(projDir, "test"), {recursive: true});
  await FS.writeFile(Path.join(projDir, "package.json"), JSON.stringify({name: "watch", version: "1.0.0", type: "module"}));
  await FS.writeFile(Path.join(projDir, "src", "math.ts"), "export const two = 2;\n");
  // Each file appends its name to a log on every run, so a rerun is countable.
  const log = Path.join(projDir, "runs.log");
  const body = (name: string, assertion: string) =>
    'import {test} from "node:test";\nimport assert from "node:assert";\nimport * as FS from "fs";\n' +
    (name === "good" ? 'import {two} from "../src/math.ts";\n' : "") +
    `FS.appendFileSync(${JSON.stringify(log)}, "${name}\\n");\n` +
    `test("${name}", () => { ${assertion} });\n`;
  await FS.writeFile(Path.join(projDir, "test", "good.test.ts"), body("good", "assert.strictEqual(two, 2);"));
  await FS.writeFile(Path.join(projDir, "test", "bad.test.ts"), body("bad", 'assert.fail("broken on purpose");'));
  const runs = (name: string) =>
    FSSync.existsSync(log) ? FSSync.readFileSync(log, "utf-8").split("\n").filter((l) => l === name).length : 0;
  return {testDir, projDir, runs};
}

if (termdomDir) test("watch mode runs, reruns failed on f, reruns the affected file on change, quits on q", async () => {
  const {testDir, projDir, runs} = await fixture();
  const {TermDOM} = await import(Path.join(termdomDir, JSON.parse(await FS.readFile(Path.join(termdomDir, "package.json"), "utf-8")).exports["."].import));
  const terminal = fakeTerminal();

  let app!: WatchApp;
  const ready = new Promise<void>((resolve) => {
    void watchTests({
      cwd: projDir, platforms: ["node"], timeout: 30000, concurrency: 1, debug: false, updateSnapshots: false,
      termdom: {TermDOM, transport: terminal.transport},
      onReady: (a) => { app = a; resolve(); },
    }).then(() => { finished = true; });
  });
  let finished = false;
  await ready;

  // The first run starts on its own.
  await app.nextRunDone();
  expect(app.files().get("test/good.test.ts")!.status).toBe("pass");
  expect(app.files().get("test/bad.test.ts")!.status).toBe("fail");
  expect(runs("good")).toBe(1);
  expect(runs("bad")).toBe(1);
  expect(app.files().get("test/bad.test.ts")!.output).toContain("broken on purpose");

  // f reruns only what failed.
  const second = app.nextRunDone();
  await terminal.press("f");
  await second;
  expect(runs("bad")).toBe(2);
  expect(runs("good")).toBe(1);

  // Editing a source only good.test.ts imports reruns good.test.ts alone.
  const third = app.nextRunDone();
  await FS.writeFile(Path.join(projDir, "src", "math.ts"), "export const two = 1 + 1;\n");
  await third;
  expect(runs("good")).toBe(2);
  expect(runs("bad")).toBe(2);

  // The screen carried the list and the footer.
  expect(terminal.screen()).toContain("test/bad.test.ts");
  expect(terminal.screen()).toContain("q quit");

  await terminal.press("q");
  for (let i = 0; i < 100 && !finished; i++) await new Promise((r) => setTimeout(r, 50));
  expect(finished).toBe(true);

  await removeTempDir(testDir);
}, 180000);
