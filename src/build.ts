// A static guide built from shared Markdown and the ports' tested snippets.
// No port toolchain is needed here: each port tests its own examples.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import MarkdownIt from "markdown-it";

interface PortSpec {
  lang: string;
  label: string;
  repo: string;
  submodule: string;
  dir: string;
  hidesLines: boolean;
  comment: string;
  keywords: string;
}

export const PORTS: readonly PortSpec[] = [
  {
    lang: "rust",
    label: "Rust",
    repo: "causet.rs",
    submodule: "rust",
    dir: "crates/causet/guide",
    hidesLines: true,
    comment: "//[^\\n]*",
    keywords:
      "as const dyn else enum false fn for if impl in let loop match mod move mut pub return Self self struct trait true type use where while Some None Ok Err",
  },
  {
    lang: "ocaml",
    label: "OCaml",
    repo: "causet.ml",
    submodule: "ocaml",
    dir: "doc",
    hidesLines: false,
    comment: "\\(\\*.*?\\*\\)",
    keywords:
      "and begin do done else end false for fun function if in include let match module mutable not of open rec sig struct then to true try type val when while with",
  },
  {
    lang: "ts",
    label: "TypeScript",
    repo: "causet.ts",
    submodule: "typescript",
    dir: "packages/causet/guide",
    hidesLines: true,
    comment: "//[^\\n]*|/\\*.*?\\*/",
    keywords:
      "as async await break case catch class const continue default do else export extends false finally for from function if implements import in instanceof interface let new null of private readonly return static switch this throw true try type typeof undefined void while yield",
  },
];

export const ORDER = [
  "overview",
  "messages",
  "authority",
  "scheduling",
  "addressing",
  "running",
  "timeouts",
  "determinism",
  "testing",
  "observability",
  "projections",
] as const;

interface Port {
  spec: PortSpec;
  root: string;
}

interface Snippet {
  code: string;
  note?: string;
}

interface Page {
  slug: string;
  title: string;
  summary: string;
  body: string;
  /** The line of the page's file on which the body starts. */
  line: number;
}

interface Examples {
  port: Port;
  file: string;
  snippets: Map<string, Snippet>;
  used: Set<string>;
}

export class GuideError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

const markdown = new MarkdownIt("commonmark").enable("table");
const inlineMarkdown = new MarkdownIt("commonmark");
const variantOpen = new RegExp(`\\{(${PORTS.map((p) => p.lang).join("|")}):`);
// A line that starts with `{{` or `:::` is a directive, and one that does not
// parse fails the build, rather than vanishing or showing as prose.
const codeDirective = /^\{\{code\s+([^\s{}]+)(?:\s+only=([^\s{}]+))?\s*\}\}$/;
const figureDirective = /^\{\{figure\s+([^\s{}]+)(?:\s+(.*?))?\s*\}\}$/;

function lines(text: string): string[] {
  const result = text.split(/\r?\n/);
  if (result.at(-1) === "") result.pop();
  return result;
}

function fail(problem: string): never {
  throw new GuideError([problem]);
}

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build relative to the repository, with explicit CLI paths relative to `cwd`. */
export function buildGuide(
  here: string,
  args: readonly string[],
  cwd: string = process.cwd(),
): { pages: number; out: string } {
  const roots = new Map(PORTS.map((p) => [p.lang, join(here, "ports", p.submodule)]));
  let chosen = PORTS.map((p) => p.lang);
  let out = join(here, "site");
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i];
    const value = args[i + 1];
    if (value === undefined) fail(`${arg} needs a value`);
    if (arg === "--out") out = resolve(cwd, value);
    else if (arg === "--ports") chosen = value.split(",").map((lang) => lang.trim());
    else if (arg?.startsWith("--") && roots.has(arg.slice(2))) {
      roots.set(arg.slice(2), resolve(cwd, value));
    } else fail(`unknown argument ${arg}`);
  }
  for (const lang of chosen) {
    if (!roots.has(lang)) fail(`--ports: no port \`${lang}\``);
    if (chosen.indexOf(lang) !== chosen.lastIndexOf(lang)) {
      fail(`--ports: duplicate port \`${lang}\``);
    }
  }
  const ports: Port[] = PORTS.filter((p) => chosen.includes(p.lang)).map((spec) => {
    const root = roots.get(spec.lang) ?? "";
    try {
      return { spec, root: realpathSync(root) };
    } catch {
      return { spec, root: resolve(root) };
    }
  });

  const errors: string[] = [];
  const pages: Page[] = [];
  for (const slug of ORDER) {
    try {
      pages.push(readPage(here, slug));
    } catch (error) {
      errors.push(problemText(error));
    }
  }
  if (errors.length) throw new GuideError(errors);
  // A port's guide folder holds one file per page: the examples in any other
  // Markdown file there would never be read, let alone checked.
  const slugs = new Set<string>(ORDER);
  for (const port of ports) {
    const dir = join(port.root, port.spec.dir);
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue; // Each page's own read reports a missing folder.
    }
    for (const name of names) {
      if (name.endsWith(".md") && !slugs.has(name.slice(0, -3))) {
        errors.push(`${join(dir, name)}: the guide has no page \`${name.slice(0, -3)}\``);
      }
    }
  }
  mkdirSync(out, { recursive: true });
  const template = readFileSync(join(here, "src/page.html"), "utf8");
  for (const [index, page] of pages.entries()) {
    const examples: Examples[] = [];
    for (const port of ports) {
      const file = join(port.root, port.spec.dir, `${page.slug}.md`);
      try {
        examples.push({
          port,
          file,
          snippets: readSnippets(file, port.spec.hidesLines),
          used: new Set(),
        });
      } catch (error) {
        errors.push(problemText(error));
      }
    }
    if (examples.length !== ports.length) continue;
    const body = expand(here, page, examples, errors);
    for (const { port, file, snippets, used } of examples) {
      for (const name of [...snippets.keys()].sort()) {
        if (!used.has(name)) {
          errors.push(`${file}: the ${port.spec.label} example \`${name}\` is shown on no page`);
        }
      }
    }
    const name = index === 0 ? "index.html" : `${page.slug}.html`;
    try {
      writeFileSync(join(out, name), renderPage(template, pages, index, body, ports));
    } catch (error) {
      errors.push(`${name}: ${problemText(error)}`);
    }
  }
  for (const asset of ["style.css", "guide.js"]) {
    try {
      copyFileSync(join(here, "assets", asset), join(out, asset));
    } catch (error) {
      errors.push(`assets/${asset}: ${problemText(error)}`);
    }
  }
  if (errors.length) throw new GuideError(errors);
  return { pages: pages.length, out };
}

function readPage(here: string, slug: string): Page {
  const file = join(here, "pages", `${slug}.md`);
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---\n")) fail(`${file}: no header`);
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) fail(`${file}: unterminated header`);
  let title: string | undefined;
  let summary: string | undefined;
  for (const line of lines(text.slice(4, end))) {
    const colon = line.indexOf(":");
    const key = line.slice(0, colon);
    if (colon !== -1 && key === "title") title = line.slice(colon + 1).trim();
    else if (colon !== -1 && key === "summary") summary = line.slice(colon + 1).trim();
    else fail(`${file}: unknown header line \`${line}\``);
  }
  if (title === undefined) fail(`${file}: no title`);
  if (summary === undefined) fail(`${file}: no summary`);
  const line = text.slice(0, end + 5).split("\n").length;
  return { slug, title, summary, body: text.slice(end + 5), line };
}

function readSnippets(file: string, hidesLines: boolean): Map<string, Snippet> {
  const source = lines(readFileSync(file, "utf8"));
  const snippets = new Map<string, Snippet>();
  for (let i = 0; i < source.length; i++) {
    const match = source[i]?.trim().match(/^<!-- snippet:([\s\S]*?)-->$/);
    if (!match) continue;
    const name = match[1]?.trim() ?? "";
    const at = i + 1;
    let note: string | undefined;
    let info: string | undefined;
    while (++i < source.length) {
      const line = source[i] ?? "";
      if (!line.trim()) continue;
      if (line.trimStart().startsWith("<!--")) {
        if (line.includes("$MDX") && line.includes("skip")) note = "excerpt";
      } else if (line.startsWith("```")) {
        info = line.slice(3).trim();
        break;
      } else break;
    }
    if (info === undefined)
      fail(`${file}:${at}: snippet \`${name}\` is not followed by a code block`);
    for (const flag of info.split(",").map((flag) => flag.trim())) {
      if (flag === "compile_fail") note = "does not compile";
      if (flag === "should_panic") note = "panics";
      if (flag === "ignore") note = "excerpt";
    }
    const code: string[] = [];
    while (++i < source.length) {
      let line = source[i] ?? "";
      if (line.trimEnd() === "```") break;
      if (hidesLines && (line.trim() === "#" || line.trimStart().startsWith("# "))) continue;
      if (hidesLines && line.trimStart().startsWith("##")) line = line.replace("##", "#");
      code.push(line);
    }
    if (i === source.length) fail(`${file}: snippet \`${name}\` is not closed`);
    if (snippets.has(name)) fail(`${file}: snippet \`${name}\` appears twice`);
    snippets.set(name, { code: code.join("\n").replace(/^\n+|\n+$/g, ""), note });
  }
  return snippets;
}

function expand(here: string, page: Page, examples: Examples[], errors: string[]): string {
  let out = "";
  let prose = "";
  const langs = examples.map(({ port }) => port.spec.lang);
  const flush = () => {
    out += variants(prose, langs);
    prose = "";
  };
  const source = `pages/${page.slug}.md`;
  // The open `::: LANG` block; its lines are left out unless LANG is built.
  let block: { lang: string; line: number } | undefined;
  let dropping = false;
  let inFence = false;
  for (const [at, line] of lines(page.body).entries()) {
    const place = `${source}:${page.line + at}`;
    const trimmed = line.trim();
    const fence = line.startsWith("```");
    if (inFence || fence || !(trimmed.startsWith(":::") || trimmed.startsWith("{{"))) {
      if (fence) inFence = !inFence;
      if (dropping) continue;
      if (inFence || fence) {
        flush();
        out += `${line}\n`;
      } else prose += `${line}\n`;
      continue;
    }
    flush();
    if (trimmed === ":::") {
      if (!block) errors.push(`${place}: \`:::\` closes no block`);
      else if (!dropping) out += "\n</div>\n\n";
      block = undefined;
      dropping = false;
      continue;
    }
    if (trimmed.startsWith("::: ")) {
      const lang = trimmed.slice(4).trim();
      if (!PORTS.some((p) => p.lang === lang)) errors.push(`${place}: no port \`${lang}\``);
      if (block) {
        errors.push(
          `${place}: \`::: ${lang}\` opens inside the \`::: ${block.lang}\` block of line ${block.line}`,
        );
        continue;
      }
      block = { lang, line: page.line + at };
      dropping = !langs.includes(lang);
      if (!dropping) out += `\n<div class="${onlyClass([lang])}">\n\n`;
      continue;
    }
    const code = trimmed.match(codeDirective);
    const figure = trimmed.match(figureDirective);
    if (!code && !figure) {
      errors.push(
        trimmed.startsWith(":::")
          ? `${place}: cannot read \`${trimmed}\`: a block opens with \`::: LANG\` and closes with \`:::\``
          : `${place}: cannot read \`${trimmed}\`: a directive is a line of its own, \`{{code NAME}}\`, \`{{code NAME only=LANGS}}\` or \`{{figure NAME caption}}\``,
      );
      continue;
    }
    const only = code?.[2]?.split(",");
    for (const lang of only ?? []) {
      if (!PORTS.some((p) => p.lang === lang)) errors.push(`${place}: no port \`${lang}\``);
    }
    if (dropping) continue;
    if (code) {
      const name = code[1] ?? "";
      const shown = only ? langs.filter((lang) => only.includes(lang)) : langs;
      let panels = "";
      let heads = "";
      for (const { port, file, snippets, used } of examples) {
        const filename = relative(port.root, file);
        const snippet = snippets.get(name);
        if (shown.includes(port.spec.lang)) {
          if (!snippet) {
            errors.push(
              `${place}: the ${port.spec.label} example \`${name}\` is missing from ${port.spec.repo}/${filename}`,
            );
            continue;
          }
          used.add(name);
          const note = snippet.note ? ` <span class="note">${snippet.note}</span>` : "";
          const cls = onlyClass([port.spec.lang]);
          heads += `<span class="${cls}">${port.spec.repo} / ${escapeHtml(filename)}${note}</span>`;
          // No literal blank lines: CommonMark would end the HTML block early.
          panels += `<pre class="${cls}"><code>${highlight(snippet.code, port.spec).replaceAll("\n", "&#10;")}</code></pre>`;
        } else if (snippet) {
          errors.push(
            `${place}: \`${name}\` is marked only=${only?.join(",") ?? ""} but ${port.spec.repo}/${filename} has it too`,
          );
        }
      }
      if (!shown.length) continue;
      const cls = only ? `code ${onlyClass(shown)}` : "code";
      out += `\n<div class="${cls}"><div class="code-head"><span class="file">${heads}</span><span class="tabs">${languageSwitch(examples.map(({ port }) => port))}</span></div>${panels}</div>\n\n`;
    } else if (figure) {
      const name = figure[1] ?? "";
      const caption = figure[2] ?? "";
      const file = join(here, "figures", `${name}.svg`);
      try {
        const svg = readFileSync(file, "utf8").trim().replaceAll("\n", " ");
        const figcaption = caption
          ? `<figcaption>${inline(variants(caption, langs))}</figcaption>`
          : "";
        out += `\n<figure><div class="fig-scroll">${svg}</div>${figcaption}</figure>\n\n`;
      } catch (error) {
        errors.push(`${place}: ${file}: ${problemText(error)}`);
      }
    }
  }
  if (block) errors.push(`${source}:${block.line}: \`::: ${block.lang}\` is never closed`);
  flush();
  return out;
}

function onlyClass(langs: readonly string[]): string {
  return `only${langs.map((lang) => ` l-${lang}`).join("")}`;
}

function variants(text: string, langs: readonly string[]): string {
  let out = "";
  let rest = text;
  for (;;) {
    const match = variantOpen.exec(rest);
    if (!match) return out + rest;
    out += rest.slice(0, match.index);
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < rest.length; end++) {
      if (rest[end] === "{") depth++;
      if (rest[end] === "}") depth--;
      if (depth === 0) break;
    }
    if (depth !== 0) return out + rest.slice(match.index);
    const lang = match[1] ?? "";
    if (langs.includes(lang)) {
      out += `<span class="${onlyClass([lang])}">${rest.slice(start, end).trim()}</span>`;
    }
    rest = rest.slice(end + 1);
    if (!langs.includes(lang)) {
      // A variant left out that fills its line takes the line with it: the
      // empty line it would leave ends the paragraph around it.
      const lineStart = out.lastIndexOf("\n") + 1;
      const lineEnd = /^[ \t]*(?:\r?\n|$)/.exec(rest);
      if (lineEnd && out.slice(lineStart).trim() === "") {
        out = out.slice(0, lineStart);
        rest = rest.slice(lineEnd[0].length);
      }
    }
  }
}

function inline(text: string): string {
  const html = inlineMarkdown.render(text).trim();
  return html.startsWith("<p>") && html.endsWith("</p>") ? html.slice(3, -4) : html;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// The only entities markdown-it writes in text. An anchor is made from the
// text as shown, so `"quiet"` gives `quiet`, not `quot-quiet-quot`.
const entities = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
]);

function unescapeHtml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot);/g, (entity) => entities.get(entity) ?? entity);
}

function slug(text: string): string {
  let result = "";
  for (const char of text) {
    if (/[\p{Alphabetic}\p{Number}]/u.test(char)) result += char.toLowerCase();
    else if (result && !result.endsWith("-")) result += "-";
  }
  return result.replace(/-$/, "");
}

function languageSwitch(ports: readonly Port[]): string {
  return ports
    .map(({ spec }) => `<button type="button" data-lang="${spec.lang}">${spec.label}</button>`)
    .join("");
}

function renderPage(
  template: string,
  pages: Page[],
  index: number,
  body: string,
  ports: Port[],
): string {
  const page = pages[index];
  if (!page) throw new Error(`no page at index ${index}`);
  let toc = "";
  let content = markdown.render(body).replace(/<h2>(.*?)<\/h2>/g, (_heading, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, "");
    const id = slug(unescapeHtml(text));
    toc += `<li><a href="#${id}">${text}</a></li>`;
    return `<h2 id="${id}">${inner}</h2>`;
  });
  content = content
    .replaceAll("<table>", '<div class="table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
  const href = (i: number) => (i === 0 ? "index.html" : `${pages[i]?.slug}.html`);
  const nav = pages
    .map(
      (p, i) =>
        `<li><a href="${href(i)}"${i === index ? ' aria-current="page"' : ""}><span>${i}</span><span>${p.title}</span></a></li>`,
    )
    .join("");
  const next = pages[index + 1];
  const nextLink = next
    ? `<a class="next-page" href="${href(index + 1)}"><span>Next</span><strong>${next.title}</strong><span>${next.summary}</span></a>`
    : "";
  const langs = ports.map(({ spec }) => spec.lang);
  const hiding =
    langs
      .map((lang) => `:root[data-lang="${lang}"] .only:not(.l-${lang}){display:none!important}`)
      .join("") +
    `:root:not([data-lang]) .only:not(.l-${langs[0] ?? "rust"}){display:none!important}`;
  const replacements: Record<string, string> = {
    langs: langs.map((lang) => `"${lang}"`).join(","),
    hiding,
    switch: languageSwitch(ports),
    title: index === 0 ? "Causet Guide" : `${page.title} · Causet Guide`,
    description: escapeHtml(page.summary),
    nav,
    number: String(index),
    heading: page.title,
    summary: inline(variants(page.summary, langs)),
    toc,
    next: nextLink,
    content,
  };
  for (const [key, value] of Object.entries(replacements)) {
    template = template.replaceAll(`{{${key}}}`, () => value);
  }
  return template;
}

// Match the Unicode word boundaries used by the original highlighter;
// JavaScript's \b would highlight a keyword inside an identifier like letπ.
const word = "[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]";
const highlighters = new Map(
  PORTS.map((p) => [
    p.lang,
    new RegExp(
      `(${p.comment})|("(?:[^"\\\\]|\\\\.)*")|(?<!${word})(${p.keywords.split(" ").join("|")})(?!${word})|(?<!${word})(\\p{Nd}[\\p{Nd}_]*)(?!${word})`,
      "gsu",
    ),
  ]),
);

function highlight(code: string, port: PortSpec): string {
  const re = highlighters.get(port.lang);
  if (!re) throw new Error(`no highlighter for ${port.lang}`);
  let out = "";
  let last = 0;
  for (const match of code.matchAll(re)) {
    out += escapeHtml(code.slice(last, match.index));
    const cls =
      match[1] !== undefined
        ? "c"
        : match[2] !== undefined
          ? "s"
          : match[3] !== undefined
            ? "k"
            : "n";
    out += `<span class="${cls}">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return out + escapeHtml(code.slice(last));
}
