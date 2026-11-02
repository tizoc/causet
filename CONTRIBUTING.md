# Contributing to the guide

This repository holds the guide, built from the pages in `pages/` and the
ports' tested examples. The port submodules under `ports/` pin the source
revisions used by the guide.

## Building locally

Use Node.js 24 or newer and pnpm 10.7.1. The builder runs TypeScript
directly; building the guide does not require the ports' toolchains.

```sh
git clone --recurse-submodules https://github.com/tizoc/causet.git
cd causet
pnpm install --frozen-lockfile
pnpm build           # builds site/ from pages/ and the ports in ports/
```

`pnpm build --rust DIR --ocaml DIR --ts DIR --out DIR` reads the ports from
other checkouts instead, such as ones being worked on. Relative paths are
taken from the directory you run it in.

Run `pnpm check`, `pnpm lint` and `pnpm test` to check the builder. The tests
build all seven combinations of ports, check navigation and exercise the
directive and snippet validation. They require the pinned submodules;
the ports test the examples themselves in their own repositories.

## How a page is made

A page in `pages/` is Markdown with a short header:

```markdown
---
title: Scheduling
summary: The order in which work runs, admission, and faults.
---
```

and four directives:

- `{{code NAME}}`, on a line of its own, shows the example `NAME` from
  every port, one tab each. Every port must have it, unless the directive
  names the ones that do: `{{code NAME only=rust}}` or `only=rust,ocaml`,
  which is then shown only while one of those languages is selected.
- `{{figure NAME caption}}` inlines `figures/NAME.svg`, with an optional
  caption.
- `{LANG: text}` shows text only while that language is selected, such as
  an API name: `{rust: Store::dispatch_to}{ocaml: Store.dispatch_to}`. The
  languages are `rust`, `ocaml` and `ts`.
- `::: LANG` and `:::` around whole paragraphs do the same for blocks.

A line that starts with `{{` or `:::` must be one of these directives, and
every `::: LANG` needs its `:::`; otherwise the build fails, naming the page
and line.

The ports, their repositories, where their examples live and how their
code is highlighted are one list in `src/build.ts`; the language switch and
what each choice hides are generated from it. `--ports rust,ocaml` builds
with some of them only, leaving the others' text and examples out.

## Where the examples are

A port keeps the examples of the page `p` in one file, tested by its own
tools:

| Port | File | Tested by |
| --- | --- | --- |
| Rust | `crates/causet/guide/p.md` | `cargo test -p causet --doc` |
| OCaml | `doc/p.md` | `dune test doc` (mdx) |
| TypeScript | `packages/causet/guide/p.md` | `pnpm --filter causet doctest` |

Each example is a fenced code block preceded by
`<!-- snippet: NAME -->`. Hidden `# ` lines (Rust's and TypeScript's) are left out of the
page; an example marked `compile_fail`, `should_panic`, `ignore` or
`$MDX skip` is labelled as such.

The build fails on an example a page names that a port lacks, on an
example a port has that no page shows, and on a Markdown file in a port's
guide folder that is not one of the pages, so the pages and the ports
cannot drift apart.

## The look

`assets/style.css` and `src/page.html`: ink on white, a book serif for
prose (Newsreader), Geist for labels and Geist Mono for code, one 40rem
column between the list of pages and the page's sections. The reader's
language is remembered in the browser.
