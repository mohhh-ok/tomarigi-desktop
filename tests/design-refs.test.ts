// Every reference to the design docs (`docs/design/<file>.md "<name>"`) points to a file that exists and to a heading in
// it, or to a list item that starts with that name (docs/design.md, the index). A renamed or moved section breaks the
// references to it here instead of leaving them pointing nowhere. The old single-file form `docs/design.md "<name>"`
// is gone: the index is the only place that names docs/design.md with a section after it.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const designDir = join(root, "docs/design");

interface Ref {
  path: string;
  name?: string;
}

/** Comment markers that can start the next line when a reference wraps in code (`//`, `///`, ` * `, `#`) */
const WRAP = /[ \t]*\n[ \t]*(?:\/\/\/?|\*|#)?[ \t]*/g;

/** The references in a text. A name can wrap onto the next comment line, be escaped (`\"`), or hold quotes itself
 * (`The "?" for sessions waiting on you`), so known names are tried first, longest first */
function findRefs(text: string, known: string[]): Ref[] {
  const refs: Ref[] = [];
  const re = /docs\/design\/([a-z0-9-]+\.md)/g;
  for (const m of text.matchAll(re)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const q = after.match(/^`?(\s*(?:\n\s*(?:\/\/\/?|\*|#|\{\/\*)\s*)?)(\\?")/);
    if (!q) {
      refs.push({ path: m[1] });
      continue;
    }
    const quote = q[2];
    const rest = after.slice(q[0].length).replace(WRAP, " ");
    const unescaped = quote === '\\"' ? rest.replaceAll('\\"', '"') : rest;
    const close = quote === '\\"' ? '"' : quote;
    const name =
      known.find((k) => unescaped.startsWith(k + close)) ?? unescaped.slice(0, unescaped.indexOf(close));
    refs.push({ path: m[1], name });
  }
  return refs;
}

/** The names a reference may point to in one design file: its headings and the starts of its list items */
function targets(file: string): { headings: string[]; items: string[] } {
  const lines = readFileSync(join(designDir, file), "utf8").split("\n");
  return {
    headings: lines.flatMap((l) => l.match(/^#+ (.*)$/)?.[1] ?? []),
    items: lines.flatMap((l) => l.match(/^\s*- (.*)$/)?.[1] ?? []),
  };
}

const designFiles = readdirSync(designDir).filter((f) => f.endsWith(".md"));
const known = designFiles.flatMap((f) => targets(f).headings).sort((a, b) => b.length - a.length);
const self = relative(root, import.meta.path);
const repoFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => f && f !== self && existsSync(join(root, f)));

function read(f: string): string | undefined {
  const text = readFileSync(join(root, f), "utf8");
  return text.includes("\u0000") ? undefined : text;
}

describe("findRefs", () => {
  test("a name wrapped onto the next comment line", () => {
    expect(findRefs('// see (docs/design/layout.md\n  // "Layout")', [])).toEqual([
      { path: "layout.md", name: "Layout" },
    ]);
    expect(findRefs('// see (docs/design/x.md "Side chats and\n// forked sessions")', [])).toEqual([
      { path: "x.md", name: "Side chats and forked sessions" },
    ]);
  });

  test("an escaped name and a name holding quotes", () => {
    expect(findRefs('describe("a (docs/design/layout.md \\"Layout\\")"', [])).toEqual([
      { path: "layout.md", name: "Layout" },
    ]);
    const known = ['The "?" for sessions waiting on you'];
    expect(findRefs('(docs/design/w.md "The "?" for sessions waiting on you")', known)).toEqual([
      { path: "w.md", name: known[0] },
    ]);
  });

  test("a path without a name", () => {
    expect(findRefs("kept (docs/design/other.md)", [])).toEqual([{ path: "other.md" }]);
  });
});

describe("references to the design docs", () => {
  test("every reference points to a design file and a heading or list item in it", () => {
    const broken: string[] = [];
    for (const f of repoFiles) {
      const text = read(f);
      if (!text?.includes("docs/design/")) continue;
      for (const ref of findRefs(text, known)) {
        if (!designFiles.includes(ref.path)) {
          broken.push(`${f}: docs/design/${ref.path} doesn't exist`);
          continue;
        }
        if (ref.name === undefined) continue;
        const t = targets(ref.path);
        const name = ref.name;
        if (!t.headings.includes(name) && !t.items.some((i) => i.startsWith(name))) {
          broken.push(`${f}: "${name}" isn't a heading or a list item in docs/design/${ref.path}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test('`docs/design.md "<name>"` is written only in the index', () => {
    const old = repoFiles.filter((f) => f !== "docs/design.md" && /docs\/design\.md`?\s+\\?"/.test(read(f) ?? ""));
    expect(old).toEqual([]);
  });

  test("the index lists every design file", () => {
    const index = readFileSync(join(root, "docs/design.md"), "utf8");
    expect(designFiles.filter((f) => !index.includes(`(design/${f})`))).toEqual([]);
  });
});
