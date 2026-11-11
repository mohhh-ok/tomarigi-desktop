// Whether a change can change the LLM regression test's results, so `bun run test:llm` has to run (docs/design.md
// "LLM regression test"). What counts is found, not listed: every top-level declaration the test reaches from its own
// files (tools/llm-regression/*.ts), following references through the TypeScript checker into src/ (the prompts, the
// schemas, the models, the request bodies, the reading of answers, the payload builders, the checks after the answer
// such as dropReason). A function added on that path is picked up without editing anything here. A change inside one of
// those declarations, or anywhere in tools/llm-regression/, needs a run; a change only elsewhere (the UI, the scheduler,
// comments between declarations) doesn't.
//
// The transport (transport.ts) copies the URLs, headers, and timeouts of src-tauri/src/keys.rs, which the checker can't
// follow; tests/llm-transport.test.ts checks they match, and a change to keys.rs counts here too.
//
// usage: bun run test:llm:needed [base]   (base defaults to the merge base with the branch's upstream, or origin/main
// when it has none, so commits not pushed yet count; the working tree and untracked files are included). Prints "run"
// or "not needed" with the reasons, and exits 0 either way.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const testDir = join(root, "tools/llm-regression");
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
/** What has been pushed: the upstream of the branch, or origin/main */
function pushed(): string {
  try {
    // A branch without an upstream makes git print "fatal: no upstream"; that is expected here, so it isn't shown
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "origin/main";
  }
}
const base = process.argv[2] ?? git("merge-base", "HEAD", pushed()).trim();

/** A top-level statement of a source file, the unit that is reached or changed */
interface Unit {
  file: string;
  start: number;
  end: number;
  name: string;
}

const program = ts.createProgram([join(testDir, "run.ts")], {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  jsx: ts.JsxEmit.ReactJSX,
  baseUrl: root,
  paths: { "@/*": ["./src/*"] },
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const inRepo = (f: string) => f.startsWith(root) && !f.includes("/node_modules/");

function topLevelOf(node: ts.Node): ts.Statement | undefined {
  let n: ts.Node = node;
  while (n.parent && !ts.isSourceFile(n.parent)) n = n.parent;
  return n.parent && ts.isSourceFile(n.parent) ? (n as ts.Statement) : undefined;
}

function nameOf(s: ts.Statement): string {
  if (ts.isVariableStatement(s)) return s.declarationList.declarations.map((d) => d.name.getText()).join(", ");
  const named = s as ts.Statement & { name?: ts.Node };
  return named.name ? named.name.getText() : ts.SyntaxKind[s.kind];
}

function unitOf(s: ts.Statement): Unit {
  const sf = s.getSourceFile();
  const line = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  return { file: relative(root, sf.fileName), start: line(s.getStart()), end: line(s.getEnd()), name: nameOf(s) };
}

// Reach every top-level statement the test's files use, through the checker's symbols
const reached = new Map<ts.Statement, Unit>();
const queue: ts.Statement[] = [];
const reach = (s: ts.Statement) => {
  if (reached.has(s) || !inRepo(s.getSourceFile().fileName)) return;
  reached.set(s, unitOf(s));
  queue.push(s);
};
for (const sf of program.getSourceFiles()) {
  if (resolve(dirname(sf.fileName)) === testDir) sf.statements.forEach(reach);
}
while (queue.length) {
  const s = queue.pop()!;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const d of symbol?.declarations ?? []) {
        const top = topLevelOf(d);
        // Imports are reached through what they bind, not as statements
        if (top && !ts.isImportDeclaration(top)) reach(top);
      }
    }
    ts.forEachChild(node, visit);
  };
  // An import's own text doesn't change a result; what it names is followed from where it is used
  if (!ts.isImportDeclaration(s)) visit(s);
}

// The lines a change touches, per file, in the working tree's numbering. A deletion touches the line it sits at
const touched = new Map<string, number[]>();
const diff = git("diff", "-U0", "--no-color", base, "--", ".");
let current = "";
for (const line of diff.split("\n")) {
  const file = /^\+\+\+ b\/(.+)$/.exec(line);
  if (file) current = file[1];
  if (line.startsWith("+++ /dev/null")) current = "";
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (hunk && current) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = count === 0 ? [start, start + 1] : Array.from({ length: count }, (_, i) => start + i);
    touched.set(current, [...(touched.get(current) ?? []), ...lines]);
  }
}
for (const f of git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean)) {
  if (!existsSync(join(root, f))) continue;
  touched.set(f, Array.from({ length: readFileSync(join(root, f), "utf8").split("\n").length }, (_, i) => i + 1));
}
// Files deleted since base that the test used are gone from the graph; a deleted file under the test's folder counts
const deleted = git("diff", "--name-only", "--diff-filter=D", base, "--", "tools/llm-regression").split("\n").filter(Boolean);

const reasons: string[] = deleted.map((f) => `${f}: deleted from the test's folder`);
// Not TypeScript, so not followed: the values transport.ts copies come from here
const KEYS_RS = "src-tauri/src/keys.rs";
if (touched.has(KEYS_RS)) reasons.push(`${KEYS_RS}: the URLs, headers, and timeouts transport.ts copies`);
const testFiles = new Set<string>();
for (const u of reached.values()) {
  const lines = touched.get(u.file);
  if (!lines?.some((l) => l >= u.start && l <= u.end)) continue;
  // The test's own files count whole: one line per file
  if (u.file.startsWith("tools/llm-regression/")) testFiles.add(u.file);
  else reasons.push(`${u.file}:${u.start} ${u.name}`);
}
for (const f of testFiles) reasons.push(`${f}: the test's own file`);

console.log(`base ${base.slice(0, 12)}; the test reaches ${reached.size} declarations in ${new Set([...reached.values()].map((u) => u.file)).size} files`);
if (reasons.length) {
  console.log("run: bun run test:llm (these changes can change the results)");
  for (const r of reasons.sort()) console.log(`  ${r}`);
} else {
  console.log("not needed: no change reaches the test's prompts, schemas, models, requests, inputs, or checks");
}
