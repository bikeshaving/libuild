/**
 * `libuild test --watch`: the usual output, kept live. Files rerun when a
 * source they pulled in changes, failed files rerun on `f`, everything on
 * `a`, and the lines redraw in place.
 *
 * The output is a termdom document drawn in the normal flow under the
 * prompt - no alternate screen - and redrawn on mutation. termdom is loaded
 * from the project's node_modules, the way playwright is for browser tests,
 * so libuild itself does not carry it.
 */
import * as FS from "fs";
import * as Path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import {
  collectTests,
  runTests,
  defaultPatternsFor,
  headingLine,
  fileLine,
  summaryLines,
  type Line,
  type Platform,
  type Reporter,
  type TestResult,
  type TestRunnerOptions,
} from "./test-runner.ts";

export interface WatchOptions extends Omit<TestRunnerOptions, "reporter"> {
  /** For tests: the TermDOM class and a transport, instead of the project's termdom and the real terminal. */
  termdom?: { TermDOM: any; transport?: unknown };
  /** For tests: called with the app once it is attached. */
  onReady?: (app: WatchApp) => void;
}

type Status = "idle" | "running" | "pass" | "fail";

interface FileState {
  file: string;
  abs: string;
  status: Status;
  results: Map<Platform, TestResult>;
  output: string;
  inputs: Set<string>;
}

/** What a test can see and drive. */
export interface WatchApp {
  files(): ReadonlyMap<string, FileState>;
  running(): boolean;
  /** Resolves after the current run (or the next one, if none is running) ends. */
  nextRunDone(): Promise<void>;
  run(selection: "all" | "failed" | string[]): void;
  quit(): void;
  document: any;
}

const KEYS_HELP = "a rerun all · f rerun failed · u update snapshots · Enter rerun · q quit";

const STYLE = `
  body { margin: 0; }
  .pass { color: #5fd75f; }
  .fail { color: #ff5f5f; }
  .todo { color: #ffd75f; }
  .skip { color: #808080; }
  .running { color: #ffd75f; }
  .idle { color: #808080; }
  .output { margin: 0; white-space: pre-wrap; }
  #summary { margin-top: 1em; }
  #keys { margin-top: 1em; color: #808080; }
`;

async function loadTermDOM(cwd: string): Promise<any> {
  const require = createRequire(Path.join(cwd, "package.json"));
  let pkgPath: string;
  try {
    pkgPath = require.resolve("@b9g/termdom/package.json");
  } catch {
    throw new Error(
      "libuild test --watch needs @b9g/termdom in this project.\nInstall it with: npm install -D @b9g/termdom"
    );
  }
  const dir = Path.dirname(pkgPath);
  const pkg = JSON.parse(FS.readFileSync(pkgPath, "utf-8"));
  const dot = pkg.exports?.["."];
  const entry = typeof dot === "string" ? dot : dot?.import ?? dot?.default ?? pkg.module ?? pkg.main;
  return await import(pathToFileURL(Path.join(dir, entry)).href);
}

export async function watchTests(options: WatchOptions): Promise<void> {
  const cwd = options.cwd;
  const platforms = options.platforms;
  const patterns = options.patterns ?? (options.files?.length ? [] : defaultPatternsFor(cwd));

  const { TermDOM } = options.termdom ?? (await loadTermDOM(cwd));
  const term = new TermDOM(options.termdom?.transport ? { transport: options.termdom.transport } : {});
  const { document } = term;

  const files = new Map<string, FileState>();
  const log: string[] = [];
  let running = false;
  let pending: "all" | "failed" | Set<string> | null = null;
  let updateSnapshotsOnce = false;
  let quitting = false;
  let runWaiters: Array<() => void> = [];

  const stateFor = (file: string): FileState => {
    let state = files.get(file);
    if (!state) {
      state = { file, abs: Path.resolve(cwd, file), status: "idle", results: new Map(), output: "", inputs: new Set() };
      files.set(file, state);
    }
    return state;
  };

  const collect = async (): Promise<void> => {
    const { testFiles } = await collectTests(cwd, patterns, options.files ?? []);
    const seen = new Set<string>();
    for (const abs of testFiles) {
      const rel = Path.relative(cwd, abs);
      seen.add(rel);
      stateFor(rel);
    }
    for (const rel of [...files.keys()]) {
      if (!seen.has(rel)) files.delete(rel);
    }
  };

  // ---- rendering -----------------------------------------------------------
  //
  // The document is the same output `libuild test` prints, drawn in the
  // normal flow under the prompt and redrawn in place as files rerun. No
  // alternate screen: when the app quits, what it printed stays in the
  // scrollback like any other run.

  document.body.innerHTML = `
    <style>${STYLE}</style>
    <div id="heading"></div>
    <div id="files"></div>
    <div id="summary"></div>
    <div id="keys">${KEYS_HELP}</div>
  `;
  const headingEl = document.getElementById("heading");
  const filesEl = document.getElementById("files");
  const summaryEl = document.getElementById("summary");

  const marks: Record<Status, string> = { idle: "·", running: "…", pass: "✓", fail: "✗" };

  const lineEl = (line: Line, className = ""): any => {
    const el = document.createElement("div");
    if (className) el.className = className;
    for (const s of line) {
      const sp = document.createElement("span");
      if (s.tone !== "plain") sp.className = s.tone;
      sp.textContent = s.text;
      el.appendChild(sp);
    }
    return el;
  };

  const combined = (f: FileState): TestResult => {
    const total: TestResult = { platform: "", passed: 0, failed: 0, errors: [], skipped: 0, todo: 0 };
    for (const r of f.results.values()) {
      total.passed += r.passed; total.failed += r.failed;
      total.skipped! += r.skipped ?? 0; total.todo! += r.todo ?? 0;
    }
    return total;
  };

  const render = () => {
    const list = [...files.values()];
    const active = list.filter((f) => f.status === "running").length;
    headingEl.textContent = running
      ? headingLine(platforms[0], active)
      : `Watching ${list.length} file(s) on ${platforms.join(", ")}`;

    filesEl.innerHTML = "";
    for (const f of list) {
      if (f.results.size === 0) {
        const el = document.createElement("div");
        el.className = f.status;
        el.textContent = `${marks[f.status]} ${f.file}`;
        filesEl.appendChild(el);
        continue;
      }
      filesEl.appendChild(lineEl(fileLine(f.file, combined(f))));
      if (f.status === "fail" && f.output.trim()) {
        const out = document.createElement("pre");
        out.className = "output";
        out.textContent = f.output.trimEnd();
        filesEl.appendChild(out);
      }
    }

    summaryEl.innerHTML = "";
    if (!running && list.some((f) => f.results.size > 0)) {
      const results: TestResult[] = platforms.map((platform) => {
        const total: TestResult = { platform, passed: 0, failed: 0, errors: [], skipped: 0, todo: 0 };
        for (const f of list) {
          const r = f.results.get(platform);
          if (!r) continue;
          total.passed += r.passed; total.failed += r.failed;
          total.skipped! += r.skipped ?? 0; total.todo! += r.todo ?? 0;
          for (const e of r.errors) total.errors.push({ name: `${f.file} > ${e.name}`, error: e.error });
        }
        return total;
      });
      for (const line of summaryLines(results)) summaryEl.appendChild(lineEl(line));
    }
    if (log.length) {
      const note = document.createElement("div");
      note.className = "skip";
      note.textContent = log[log.length - 1];
      summaryEl.appendChild(note);
    }
  };

  // ---- running ---------------------------------------------------------------

  const reporter: Reporter = {
    fileStart(_platform, file) {
      const s = stateFor(file);
      s.status = "running";
      render();
    },
    fileInputs(_platform, file, inputs) {
      stateFor(file).inputs = new Set(inputs);
    },
    fileDone(platform, file, result, output) {
      const s = stateFor(file);
      s.results.set(platform, result);
      if (result.failed > 0 && output.trim()) s.output = output;
      const failed = [...s.results.values()].some((r) => r.failed > 0);
      s.status = failed ? "fail" : s.results.size >= platforms.length ? "pass" : "running";
      render();
    },
  };

  const selection = (which: "all" | "failed" | Set<string>): string[] => {
    const all = [...files.values()];
    if (which === "all") return all.map((f) => f.abs);
    if (which === "failed") return all.filter((f) => f.status === "fail").map((f) => f.abs);
    return all.filter((f) => which.has(f.file)).map((f) => f.abs);
  };

  const run = async (which: "all" | "failed" | Set<string>): Promise<void> => {
    if (quitting) return;
    if (running) {
      pending = pending === "all" || which === "all" ? "all"
        : pending === "failed" || which === "failed" ? (pending instanceof Set ? pending : which === "failed" ? "failed" : which)
        : new Set([...(pending ?? []), ...which]);
      return;
    }
    await collect();
    const targets = selection(which);
    if (targets.length === 0) {
      log.push(which === "failed" ? "No failed files to rerun." : "No test files found.");
      render();
      return;
    }
    running = true;
    for (const abs of targets) {
      const s = files.get(Path.relative(cwd, abs));
      if (s) { s.status = "running"; s.results.clear(); s.output = ""; }
    }
    render();
    const update = updateSnapshotsOnce;
    updateSnapshotsOnce = false;
    try {
      await runTests({ ...options, files: targets, patterns: [], updateSnapshots: options.updateSnapshots || update, reporter });
    } catch (error: any) {
      log.push(`run failed: ${error?.message ?? error}`);
    }
    running = false;
    render();
    for (const resolve of runWaiters.splice(0)) resolve();
    if (pending) {
      const next = pending;
      pending = null;
      void run(next);
    }
  };

  // ---- watching ----------------------------------------------------------------

  let watcher: FS.FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  const changed = new Set<string>();
  const IGNORED = new RegExp(`${Path.sep.replace("\\", "\\\\")}(node_modules|\\.git|dist|__snapshots__)${Path.sep.replace("\\", "\\\\")}`);

  const onChange = (name: string | null) => {
    if (!name) return;
    const abs = Path.resolve(cwd, name);
    if (IGNORED.test(abs + Path.sep)) return;
    changed.add(abs);
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      const batch = [...changed];
      changed.clear();
      const affected = new Set<string>();
      let unknown = false;
      for (const abs of batch) {
        let hit = false;
        for (const f of files.values()) {
          if (f.abs === abs || f.inputs.has(abs)) { affected.add(f.file); hit = true; }
        }
        if (!hit && /\.(test|spec)\.[cm]?[jt]sx?$/.test(abs)) unknown = true;
      }
      if (unknown) void run("all");
      else if (affected.size) void run(affected);
    }, 150);
  };

  try {
    watcher = FS.watch(cwd, { recursive: true }, (_event, name) => onChange(name));
  } catch (error: any) {
    log.push(`file watching unavailable: ${error?.message ?? error}`);
  }

  // ---- input -----------------------------------------------------------------------

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const quit = () => {
    if (quitting) return;
    quitting = true;
    watcher?.close();
    if (debounce) clearTimeout(debounce);
    void term.dispose().then(resolveClosed, resolveClosed);
  };

  document.addEventListener("keydown", (event: any) => {
    const key: string = event.key;
    if (key === "q") quit();
    else if (key === "a" || key === "Enter") void run("all");
    else if (key === "f") void run("failed");
    else if (key === "u") { updateSnapshotsOnce = true; void run("all"); }
  });

  // The runner reports through the reporter, but a few lines still go to the
  // console (file discovery, a missing playwright). While the app owns the
  // screen those go to the log pane instead.
  const realConsole = { log: console.log, error: console.error, warn: console.warn };
  const note = (...args: any[]) => { log.push(args.map(String).join(" ")); render(); };
  console.log = () => {};
  console.error = note;
  console.warn = note;

  const app: WatchApp = {
    files: () => files,
    running: () => running,
    nextRunDone: () => new Promise((resolve) => runWaiters.push(resolve)),
    run: (which) => { void run(which === "all" || which === "failed" ? which : new Set(which)); },
    quit,
    document,
  };

  const onSignal = () => quit();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await term.attach();
    await collect();
    render();
    options.onReady?.(app);
    void run("all");
    await closed;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    console.log = realConsole.log; console.error = realConsole.error; console.warn = realConsole.warn;
    watcher?.close();
  }
}
