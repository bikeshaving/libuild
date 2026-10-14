/**
 * `libuild test --watch`: the suite as a terminal app, the way jest's watch
 * mode works. Files rerun when a source they pulled in changes, failed files
 * rerun on `f`, everything on `a`, and the selected file's output is shown
 * beside the list.
 *
 * The UI is a termdom document: real DOM, redrawn on mutation. termdom is
 * loaded from the project's node_modules, the way playwright is for browser
 * tests, so libuild itself does not carry it.
 */
import * as FS from "fs";
import * as Path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import {
  collectTests,
  runTests,
  defaultPatternsFor,
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

const KEYS_HELP = "a all · f failed · Enter rerun · u snapshots · ↑↓ select · q quit";

const STYLE = `
  body { margin: 0; }
  #header { padding: 0 1ch; background: #303030; color: #e0e0e0; }
  #header .ok { color: #5fd75f; }
  #header .bad { color: #ff5f5f; }
  #header .busy { color: #ffd75f; }
  #main { display: flex; }
  #files { list-style: none; margin: 0; padding: 0 1ch; width: 44ch; overflow: auto; }
  #files li { white-space: nowrap; }
  #files li.selected { background: #444; }
  #files .pass { color: #5fd75f; }
  #files .fail { color: #ff5f5f; }
  #files .running { color: #ffd75f; }
  #files .idle { color: #808080; }
  #detail { flex: 1; margin: 0; padding: 0 1ch; overflow: auto; white-space: pre-wrap; }
  #footer { padding: 0 1ch; color: #808080; }
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
  let selected = 0;
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

  document.body.innerHTML = `
    <style>${STYLE}</style>
    <div id="header"><b>libuild watch</b> · <span id="status"></span> · <span id="summary"></span></div>
    <div id="main">
      <ul id="files"></ul>
      <pre id="detail"></pre>
    </div>
    <div id="footer">${KEYS_HELP}</div>
  `;
  const statusEl = document.getElementById("status");
  const summaryEl = document.getElementById("summary");
  const filesEl = document.getElementById("files");
  const detailEl = document.getElementById("detail");

  const marks: Record<Status, string> = { idle: "·", running: "…", pass: "✓", fail: "✗" };

  const render = () => {
    const list = [...files.values()];
    let passed = 0, failed = 0;
    for (const f of list) for (const r of f.results.values()) { passed += r.passed; failed += r.failed; }
    statusEl.textContent = running ? "running" : "idle";
    statusEl.className = running ? "busy" : failed ? "bad" : "ok";
    summaryEl.textContent = `${list.length} files · ${passed} passed · ${failed} failed`;

    filesEl.innerHTML = "";
    list.forEach((f, i) => {
      const li = document.createElement("li");
      li.className = `${f.status}${i === selected ? " selected" : ""}`;
      const counts = [...f.results.values()].reduce((a, r) => [a[0] + r.passed, a[1] + r.failed], [0, 0]);
      li.textContent = `${marks[f.status]} ${f.file}` + (f.results.size ? `  ${counts[0]}/${counts[1]}` : "");
      filesEl.appendChild(li);
    });

    const current = list[selected];
    if (current && (current.output.trim() || current.status !== "idle")) {
      const head = [...current.results.entries()]
        .map(([p, r]) => `${p}: ${r.passed} passed, ${r.failed} failed${r.skipped ? `, ${r.skipped} skipped` : ""}${r.todo ? `, ${r.todo} todo` : ""}`)
        .join("\n");
      detailEl.textContent = `${current.file}\n${head}\n\n${current.output.trimEnd()}`;
    } else {
      detailEl.textContent = log.slice(-200).join("\n");
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
    // Land on a failure, the way jest shows one first, unless the user is
    // already looking at one.
    const list = [...files.values()];
    if (list[selected]?.status !== "fail") {
      const firstFail = list.findIndex((f) => f.status === "fail");
      if (firstFail !== -1) selected = firstFail;
    }
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
    const list = [...files.values()];
    if (key === "q") quit();
    else if (key === "a") void run("all");
    else if (key === "f") void run("failed");
    else if (key === "u") { updateSnapshotsOnce = true; void run("all"); }
    else if (key === "Enter") { const f = list[selected]; if (f) void run(new Set([f.file])); }
    else if (key === "ArrowUp") { selected = Math.max(0, selected - 1); render(); }
    else if (key === "ArrowDown") { selected = Math.min(Math.max(0, list.length - 1), selected + 1); render(); }
  });

  // The runner reports through the reporter, but a few lines still go to the
  // console (file discovery, a missing playwright). While the app owns the
  // screen those go to the log pane instead.
  const realConsole = { log: console.log, error: console.error, warn: console.warn };
  const capture = (...args: any[]) => { log.push(args.map(String).join(" ")); };
  console.log = capture; console.error = capture; console.warn = capture;

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
    document.documentElement.requestFullscreen?.();
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
