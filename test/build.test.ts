import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildGuide, GuideError, ORDER, PORTS } from "../src/build.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
// Anything a page's variant or block syntax could leave behind if not expanded.
const leftover = new RegExp(
  `\\{(?:${PORTS.map((port) => port.lang).join("|")}):|:::|\\{\\{(?:code|figure) `,
);

function temporary(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "causet-guide-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function snippet(code: string, info = "", name = "example"): string {
  return `<!-- snippet: ${name} -->\n\n\`\`\`${info}\n${code}\n\`\`\`\n`;
}

function fixture(t: TestContext, body = "", examples: Record<string, string> = {}): string {
  const root = temporary(t);
  mkdirSync(join(root, "pages"));
  mkdirSync(join(root, "src"));
  copyFileSync(join(repository, "src/page.html"), join(root, "src/page.html"));
  cpSync(join(repository, "assets"), join(root, "assets"), { recursive: true });
  cpSync(join(repository, "figures"), join(root, "figures"), { recursive: true });
  for (const slug of ORDER) {
    writeFileSync(
      join(root, "pages", `${slug}.md`),
      `---\ntitle: ${slug}\nsummary: A summary.\n---\n${slug === "overview" ? body : ""}`,
    );
    for (const port of PORTS) {
      const file = join(root, "ports", port.submodule, port.dir, `${slug}.md`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, slug === "overview" ? (examples[port.lang] ?? "") : "");
    }
  }
  return root;
}

function output(root: string): string {
  buildGuide(root, []);
  return readFileSync(join(root, "site/index.html"), "utf8");
}

function rejects(root: string, expected: RegExp, args: string[] = []): GuideError {
  try {
    buildGuide(root, args);
  } catch (error) {
    assert.ok(error instanceof GuideError, String(error));
    assert.match(error.message, expected);
    return error;
  }
  assert.fail("expected the build to fail");
}

function validateLinks(out: string): void {
  for (const file of readdirSync(out).filter((name) => name.endsWith(".html"))) {
    const html = readFileSync(join(out, file), "utf8");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${file}: duplicate IDs`);
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1] ?? "", `https://guide.test/${file}`);
      if (url.origin !== "https://guide.test") continue;
      const target = join(out, decodeURIComponent(url.pathname));
      const content = readFileSync(target, "utf8");
      if (url.hash) {
        assert.ok(
          content.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),
          `${file}: ${url}`,
        );
      }
    }
  }
}

test("all seven port combinations build the real guide with working navigation", (t) => {
  const root = temporary(t);
  for (let mask = 1; mask < 8; mask++) {
    const langs = PORTS.filter((_, i) => mask & (1 << i)).map((port) => port.lang);
    const out = join(root, langs.join("-"));
    // Selection order must not change the language switch or default language.
    const result = buildGuide(repository, [
      "--ports",
      [...langs].reverse().join(","),
      "--out",
      out,
    ]);
    assert.equal(result.pages, 11);
    assert.equal(readdirSync(out).length, 13);
    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.deepEqual(
      [...new Set([...html.matchAll(/data-lang="(rust|ocaml|ts)"/g)].map((match) => match[1]))],
      langs,
    );
    assert.ok(html.includes(`:root:not([data-lang]) .only:not(.l-${langs[0]})`));
    for (const port of PORTS) {
      assert.equal(html.includes(`class="only l-${port.lang}"`), langs.includes(port.lang));
    }
    assert.match(html, /<strong>Unreleased\.<\/strong>/);
    for (const file of readdirSync(out).filter((name) => name.endsWith(".html"))) {
      assert.doesNotMatch(readFileSync(join(out, file), "utf8"), leftover, `${langs}: ${file}`);
    }
    validateLinks(out);
    for (const asset of ["guide.js", "style.css"]) {
      assert.equal(
        readFileSync(join(out, asset), "utf8"),
        readFileSync(join(repository, "assets", asset), "utf8"),
      );
    }
  }
});

test("snippets preserve visible code, highlighting, hidden lines, and warning labels", (t) => {
  const root = fixture(t, "{{code example}}", {
    rust: snippet(
      '# let hidden = 1;\n#\n## visible\nlet n = 42; // comment\n"<&>"',
      "rust,compile_fail",
    ),
    ocaml: `<!-- snippet: example -->\n<!-- $MDX skip -->\n\`\`\`ocaml\n# shown\nlet n = 42 (* comment *)\n\`\`\`\n`,
    ts: snippet(
      '# const hidden = 1;\n## visible\nconst n = "<&>"; /* comment */',
      "ts,should_panic",
    ),
  });
  const html = output(root);
  // The examples' hidden lines, not the word: the header's mark is aria-hidden.
  assert.doesNotMatch(html, /(let|const) hidden/);
  assert.match(html, /# visible/);
  assert.match(html, /# shown/);
  assert.match(html, /<span class="note">does not compile<\/span>/);
  assert.match(html, /<span class="note">panics<\/span>/);
  assert.match(html, /<span class="note">excerpt<\/span>/);
  assert.match(html, /<span class="k">let<\/span>/);
  assert.match(html, /<span class="n">42<\/span>/);
  assert.match(html, /<span class="c">\/\/ comment<\/span>/);
  assert.match(html, /<span class="c">\(\* comment \*\)<\/span>/);
  assert.match(html, /<span class="c">\/\* comment \*\/<\/span>/);
  assert.match(html, /<span class="s">"&lt;&amp;&gt;"<\/span>/);
  assert.match(html, /&#10;/);
});

test("variants span lines and balance braces; fences leave directives literal", (t) => {
  const root = fixture(
    t,
    "{rust: **Rust** { braces }\nacross lines}{ocaml: OCaml}{ts: TypeScript}\n\n::: rust\n\nRust paragraph.\n\n:::\n\n::: ts\n\nOmitted paragraph.\n\n```text\n:::\n```\n\n:::\n\n```text\n{{code literal}}\n{rust: literal}\n```\n",
  );
  buildGuide(root, ["--ports", "rust"]);
  const html = readFileSync(join(root, "site/index.html"), "utf8");
  assert.match(
    html,
    /<span class="only l-rust"><strong>Rust<\/strong> \{ braces \}\nacross lines<\/span>/,
  );
  assert.match(html, /<div class="only l-rust">\n<p>Rust paragraph\.<\/p>/);
  assert.doesNotMatch(html, /Omitted paragraph|>OCaml<|>TypeScript</);
  assert.match(html, /\{\{code literal\}\}\n\{rust: literal\}/);
});

test("variants hold code spans with braces, and may start a line", (t) => {
  const root = fixture(
    t,
    'Payments emits {ts: `{ kind: "paid", total }`}{rust: `Paid { total }`}.\n\n{rust: Rust} starts a paragraph.\nA line ends with\n{ocaml: `{ ocaml }` starts a line} in it.\n',
  );
  const html = output(root);
  assert.match(
    html,
    /<p>Payments emits <span class="only l-ts"><code>\{ kind: &quot;paid&quot;, total \}<\/code><\/span><span class="only l-rust"><code>Paid \{ total \}<\/code><\/span>\.<\/p>/,
  );
  assert.match(
    html,
    /<p><span class="only l-rust">Rust<\/span> starts a paragraph\.\nA line ends with\n<span class="only l-ocaml"><code>\{ ocaml \}<\/code> starts a line<\/span> in it\.<\/p>/,
  );
});

// A variant alone on its line, left out of a build without its language,
// takes the line with it: the empty line it would leave ends a paragraph.
test("a variant left out of a build leaves its paragraph whole", (t) => {
  const root = fixture(
    t,
    "The host waits.\n{rust: Rust waits on a thread.}\n  {ts: TypeScript waits on a turn.}  \nThen it drains.\n",
  );
  for (const [lang, kept] of [
    ["ts", "TypeScript waits on a turn."],
    ["rust", "Rust waits on a thread."],
    ["ocaml", undefined],
  ] as const) {
    buildGuide(root, ["--ports", lang]);
    const html = readFileSync(join(root, "site/index.html"), "utf8");
    const paragraph = /<p>The host waits\.\n([\s\S]*?)Then it drains\.<\/p>/.exec(html);
    assert.ok(paragraph, `${lang}: one paragraph`);
    if (kept) assert.match(paragraph[1] ?? "", new RegExp(kept.replace(".", "\\.")));
    else assert.equal(paragraph[1], "");
  }
});

test("highlighting keeps Unicode identifier boundaries", (t) => {
  const root = fixture(t, "{{code example only=rust}}", {
    rust: snippet("letπ let́ _let let n = ١٢;"),
  });
  const html = output(root);
  assert.match(html, /letπ let́ _let <span class="k">let<\/span>/);
  assert.match(html, /<span class="n">١٢<\/span>/);
});

test("port-specific examples, inline figures, tables, and heading anchors render", (t) => {
  const root = fixture(
    t,
    "## A *heading*\n\n{{code example only=rust}}\n\n{{figure model A **model** for {rust: Rust}{ts: TypeScript}.}}\n\n| A | B |\n|---|---|\n| x | y |\n",
    { rust: snippet("let n = 1;", "rust,ignore") },
  );
  const html = output(root);
  assert.match(html, /<h2 id="a-heading">A <em>heading<\/em><\/h2>/);
  assert.match(html, /<a href="#a-heading">A heading<\/a>/);
  assert.match(html, /<div class="code only l-rust">/);
  assert.match(html, /<figure><div class="fig-scroll"><svg/);
  assert.match(html, /<figcaption>A <strong>model<\/strong> for/);
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<span class="note">excerpt<\/span>/);
  buildGuide(root, ["--ports", "ocaml"]);
  assert.doesNotMatch(readFileSync(join(root, "site/index.html"), "utf8"), /class="code/);
});

test("heading anchors are made from the text as shown, not its HTML entities", (t) => {
  const root = fixture(
    t,
    '## The "quiet" level\n\n## Reads & writes\n\n## When `a < b`\n\n## The Store\'s clock\n',
  );
  const html = output(root);
  for (const [heading, id] of [
    ["The &quot;quiet&quot; level", "the-quiet-level"],
    ["Reads &amp; writes", "reads-writes"],
    ["When a &lt; b", "when-a-b"],
    ["The Store's clock", "the-store-s-clock"],
  ]) {
    assert.ok(html.includes(`<a href="#${id}">${heading}</a>`), heading);
  }
  assert.match(html, /<h2 id="when-a-b">When <code>a &lt; b<\/code><\/h2>/);
  validateLinks(join(root, "site"));
});

test("missing and unused examples are reported together", (t) => {
  const root = fixture(t, "{{code wanted}}", {
    rust: snippet("let n = 1;", "rust", "unused"),
  });
  const error = rejects(root, /Rust example `wanted` is missing/);
  assert.match(error.message, /OCaml example `wanted` is missing/);
  assert.match(error.message, /TypeScript example `wanted` is missing/);
  assert.match(error.message, /Rust example `unused` is shown on no page/);
});

test("malformed inputs fail with useful diagnostics", async (t) => {
  const cases = [
    { name: "duplicate snippet", code: snippet("one") + snippet("two"), error: /appears twice/ },
    {
      name: "unclosed snippet",
      code: "<!-- snippet: example -->\n```rust\nx\n",
      error: /is not closed/,
    },
    {
      name: "unfenced snippet",
      code: "<!-- snippet: example -->\nprose\n",
      error: /not followed by a code block/,
    },
    {
      name: "excluded snippet",
      code: snippet("x"),
      body: "{{code example only=ocaml}}",
      error: /marked only=ocaml but causet.rs/,
    },
    {
      name: "unknown example language",
      body: "{{code example only=python}}",
      error: /no port `python`/,
    },
    { name: "unknown block language", body: "::: python\nx\n:::", error: /no port `python`/ },
    { name: "missing figure", body: "{{figure absent}}", error: /absent.svg/ },
  ];
  for (const item of cases) {
    await t.test(item.name, (t) => {
      const root = fixture(t, item.body ?? "{{code example only=rust}}", { rust: item.code ?? "" });
      rejects(root, item.error);
    });
  }
});

test("malformed directives and blocks fail with their page and line", async (t) => {
  // The fixture's header is four lines, so the line below is the page's line 7.
  for (const [lines, error] of [
    ["{{code example}}.", /pages\/overview\.md:7: cannot read `\{\{code example\}\}\.`/],
    ["{{code}}", /pages\/overview\.md:7: cannot read `\{\{code\}\}`/],
    ["{{code example onyl=rust}}", /pages\/overview\.md:7: cannot read/],
    ["{{code example}} {{code example}}", /pages\/overview\.md:7: cannot read/],
    ["{{figure model", /pages\/overview\.md:7: cannot read `\{\{figure model`/],
    ["{{ figure model }}", /pages\/overview\.md:7: cannot read/],
    [":::rust", /pages\/overview\.md:7: cannot read `:::rust`: a block opens with `::: LANG`/],
    ["::: ts\n{{code example\n:::", /pages\/overview\.md:8: cannot read `\{\{code example`/],
    ["::: rust\n\nThe rest of the page.", /pages\/overview\.md:7: `::: rust` is never closed/],
    [":::", /pages\/overview\.md:7: `:::` closes no block/],
    [
      "::: rust\n::: ts\n:::",
      /pages\/overview\.md:8: `::: ts` opens inside the `::: rust` block of line 7/,
    ],
  ] as const) {
    await t.test(JSON.stringify(lines), (t) => {
      const examples = Object.fromEntries(PORTS.map((port) => [port.lang, snippet("x")]));
      const root = fixture(t, `Prose.\n\n${lines}\n\nMore prose.\n`, examples);
      rejects(root, error);
      // Whether a block's language is built or left out.
      rejects(root, error, ["--ports", "ocaml"]);
    });
  }
});

test("Markdown in a port's guide folder that is not a page fails the build", (t) => {
  const root = fixture(t);
  const guide = join(root, "ports/ocaml/doc");
  writeFileSync(join(guide, "readiness.md"), snippet("let x = 1"));
  // The rest of the folder is the port's own, such as OCaml's dune file.
  writeFileSync(join(guide, "dune"), "");
  writeFileSync(join(guide, "prelude.ml"), "");
  const error = rejects(
    root,
    /ports\/ocaml\/doc\/readiness\.md: the guide has no page `readiness`/,
  );
  assert.equal(error.problems.length, 1);
  buildGuide(root, ["--ports", "rust,ts"]);
});

test("invalid page headers and absent port files fail the build", async (t) => {
  for (const [header, error] of [
    ["no header", /no header/],
    ["---\ntitle: x\n", /unterminated header/],
    ["---\nother: x\n---\n", /unknown header line/],
    ["---\nsummary: x\n---\n", /no title/],
    ["---\ntitle: x\n---\n", /no summary/],
  ] as const) {
    await t.test(String(error), (t) => {
      const root = fixture(t);
      writeFileSync(join(root, "pages/overview.md"), header);
      rejects(root, error);
    });
  }
  const root = fixture(t);
  rmSync(join(root, "ports/rust/crates/causet/guide/overview.md"));
  rejects(root, /overview.md/);
});

// Runs the CLI from `cwd`. pnpm sets INIT_CWD for `pnpm test` too, so each
// run sets it explicitly, or leaves it out.
function cli(cwd: string, args: readonly string[], initCwd?: string) {
  const { INIT_CWD: _, ...env } = process.env;
  if (initCwd !== undefined) env.INIT_CWD = initCwd;
  return spawnSync(process.execPath, [join(repository, "src/main.ts"), ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

/** Copies the pinned Rust guide to `dir`, as a port checkout of its own. */
function rustCheckout(dir: string): void {
  const spec = PORTS[0];
  assert.ok(spec);
  const guide = join(dir, spec.dir);
  mkdirSync(dirname(guide), { recursive: true });
  cpSync(join(repository, "ports/rust", spec.dir), guide, { recursive: true });
}

function builtInto(stdout: string): string {
  const out = stdout.match(/^built 11 pages into (.+)\n$/)?.[1];
  assert.ok(out, stdout);
  return realpathSync(out);
}

test("CLI handles errors and resolves default inputs from the repository, not cwd", (t) => {
  const cwd = temporary(t);
  for (const [args, message] of [
    [["--out"], /--out needs a value/],
    [["--wat", "x"], /unknown argument --wat/],
    [["--ports", "python"], /no port `python`/],
    [["--ports", ""], /no port ``/],
    [["--ports", "rust,rust"], /duplicate port `rust`/],
  ] as const) {
    const result = cli(cwd, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  rustCheckout(join(cwd, "custom-rust"));
  const result = cli(cwd, ["--ports", "rust", "--rust", "custom-rust", "--out", "output"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(builtInto(result.stdout), realpathSync(join(cwd, "output")));
  assert.ok(readFileSync(join(cwd, "output/index.html"), "utf8").includes("Causet Guide"));
});

test("CLI resolves relative paths from INIT_CWD, where pnpm was run, not the script's cwd", (t) => {
  const invoked = temporary(t);
  const cwd = temporary(t);
  rustCheckout(join(invoked, "custom-rust"));
  const result = cli(cwd, ["--ports", "rust", "--rust", "custom-rust", "--out", "output"], invoked);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(builtInto(result.stdout), realpathSync(join(invoked, "output")));
  assert.ok(readFileSync(join(invoked, "output/index.html"), "utf8").includes("Causet Guide"));
  assert.deepEqual(readdirSync(cwd), []);
});
