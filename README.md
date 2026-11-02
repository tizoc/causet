<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" alt="" width="120" height="36">
</picture>

# Causet

Causet is a framework for building event-driven systems from composable
state machines. It separates state transitions from external work, so the
same components can run in production or in a deterministic simulation.

Tests define the operations to explore and the rules that must hold.
Causet automatically generates sequences of inputs and modeled failures,
checks those rules, and shrinks failures into small, reproducible cases.

> **Unreleased.** The ports have no releases on crates.io, npm or opam yet.
> Use the [commit-pinned installation instructions](#using-unreleased-ports).

The [changelog](https://github.com/tizoc/causet/blob/main/CHANGELOG.md) tracks notable changes.

Each component owns a piece of State and changes it only in its reducer, in
answer to an Action. It never touches the world directly: it asks for work
with Effects, which Services carry out, and hears back through Events. A
Store runs the components one input at a time, in a fixed order, with time
from its own clock.

**[Read the guide](https://tizoc.github.io/causet/)**: what causet solves,
the model, and the rules, with every example in Rust, OCaml and TypeScript.

## Find bugs automatically

Generated simulation tests exercise the application's real components with
controlled Services, event delivery and virtual time. Invariants catch
violations, and shrinking reduces failures to small, repeatable cases.

The [testing walkthrough](https://tizoc.github.io/causet/#find-bugs-automatically)
shows how to define a property, explore generated runs and reproduce a
failure from its saved choices.

## Ports

| Port | Repository | Planned package |
| --- | --- | --- |
| Rust | [causet.rs](https://github.com/tizoc/causet.rs) | `causet` on crates.io (unreleased) |
| OCaml | [causet.ml](https://github.com/tizoc/causet.ml) | `causet` on opam (unreleased) |
| TypeScript | [causet.ts](https://github.com/tizoc/causet.ts) | `causet` on npm (unreleased) |

The three ports follow one design and behave alike: the same scheduling
rules, the same instance IDs, the same execution traces. Each has its own
API reference and issues; package releases will follow separately.

Each port has a small runnable shop that uses the same components for a
checkout and for a simulation with reordered replies. Start there, then
follow its examples index. On a fresh clone, the OCaml and TypeScript ports
install their dependencies first; Cargo fetches Rust's by itself:

| Port | Commands, from its checkout | Examples |
| --- | --- | --- |
| Rust | `cargo run -p causet --example shop` | [Reading guide](https://github.com/tizoc/causet.rs/blob/main/examples/README.md) |
| OCaml | `opam install . --deps-only --with-test` once, then `dune exec examples/shop/main.exe` | [Reading guide](https://github.com/tizoc/causet.ml/blob/main/examples/README.md) |
| TypeScript | `pnpm install` once, then `pnpm --filter shop start` | [Reading guide](https://github.com/tizoc/causet.ts/blob/main/examples/README.md) |

This repository holds the guide, and the ports as submodules under
`ports/`, pinned to the commits the published guide describes.

## Using unreleased ports

Pin a full commit SHA, using the same revision for every package from one
port. Each port documents how to install from source:

- [Rust: Git dependencies](https://github.com/tizoc/causet.rs#getting-started).
- [OCaml: opam pins](https://github.com/tizoc/causet.ml#getting-started).
- [TypeScript: tarballs from a pinned checkout](https://github.com/tizoc/causet.ts#installation-from-a-pinned-checkout).

## Contributing

See [Contributing to the guide](CONTRIBUTING.md) for building the site,
editing pages and checking examples.

## License

Apache-2.0.
