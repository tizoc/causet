---
title: Overview
summary: Causet is a framework for building event-driven systems from composable state machines. It separates state transitions from external work, so the same components can run in production or in a deterministic simulation.
---

Tests define the operations to explore and the rules that must hold.
Causet automatically generates sequences of inputs and modeled failures,
checks those rules, and shrinks failures into small, reproducible cases.

## Implementations

The three implementations follow the same model and scheduling rules.

| Implementation | GitHub repository |
| --- | --- |
| Rust | [tizoc/causet.rs](https://github.com/tizoc/causet.rs) |
| OCaml | [tizoc/causet.ml](https://github.com/tizoc/causet.ml) |
| TypeScript | [tizoc/causet.ts](https://github.com/tizoc/causet.ts) |

The [guide source](https://github.com/tizoc/causet) is maintained separately.
Packages are not yet published; each implementation's README explains how
to install from a pinned source revision.

{{figure production-test Components never touch the world directly. They ask for work with Effects and hear back through Events, so the same code runs against either side.}}

## The problem

Event-driven behavior often becomes scattered across callbacks, tasks,
timers and shared mutable state. Timeouts, retries and delayed responses
can affect the same operation. Understanding a failure requires
reconstructing which paths ran first, and reproducing a rare ordering is
difficult.

Causet puts transition logic in reducers and makes scheduling explicit.
Tests control external inputs and time, so they can explore difficult
orderings using the application's real components.

## The model

{{figure model}}

- A **component** owns a piece of State. Only its reducer changes it, and
  only in answer to an **Action**: a request such as "charge 30".
- When the reducer needs the outside world, it emits an **Effect**: a
  description of the work, not the work itself. The component's Effect
  handler gives it to a **Service**, which does the I/O however it likes, on
  worker threads, over sockets, with real timers.
- The Service answers with an **Event**. The component's adapter turns the
  Event into an Action, and the reducer handles the answer like any other
  input.
- Components form a tree. A child reports facts to its parent with an
  **Output** (such as "checked out, total 4"), and the parent decides what
  they mean for the rest of the application.

A Store holds the whole State and runs all of it on one thread, one input
at a time, in an order fixed by a few rules ([scheduling](scheduling.html)).
Nothing changes State between inputs, and a reducer never waits: it records
what it is waiting for and returns.

## Find bugs automatically

A simulated payment gateway has a total budget of 100. Its bug is forgetting
to deduct earlier approvals. This test generates charges and decides when
to deliver replies, checking that total payments stay within the budget.
It checks the fixed gateway, then finds and shrinks a failure in the faulty
one and verifies that replay fails the same way.

The application uses the guide's Payments component, running in a real Store
with a simulated gateway. The test supplies the possible operations and an
invariant; Causet generates the runs, checks the invariant and shrinks the
failure. This is generated simulation testing, with seeded randomness and
controlled Services so a failing run can be repeated.

{{code find-bug}}

All three ports produce:

```text
seed 1: node shop: invariant "paid within budget"
shrunk 13 choices to 7
choices [1, 1, 51, 1, 1, 48, 0]
```

The shrunk run charges 52 and 49, then delivers both replies: 101 paid from
a budget of 100. `search` lets this example assert that a known bug is found;
use `check` in ordinary tests to fail on a discovered violation. Keeping the
shrunk choices gives you a reproducible regression test.

The last assertion catches the expected replay failure so this example can
pass as a documentation test. With the fault fixed, keep the choices as a
regression test and let replay run normally. The [testing](testing.html)
page develops this into timeouts, restarts and several nodes on one
simulated network.

## One checkout, step by step

Run the small shop from a checkout of your port:
{rust: `cargo run -p causet --example shop`}{ocaml: `opam install . --deps-only --with-test` once for its dependencies, then `dune exec examples/shop/main.exe`}{ts: `pnpm install` once for its dependencies, then `pnpm --filter shop start`}.
It prints the payment before and after Event delivery, then runs the same
Payments component in simulation with two replies delivered out of order.
The port's `examples/README.md` gives the reading order and commands for
the larger reference applications.

The guide's example application is a small shop: a cart and a payments
component under one root, and a gateway Service that payments charges
through.

| Mount | Component | What it does |
| --- | --- | --- |
| `/` | {rust: `ShopRoot`}{ocaml: `shop_root`}{ts: `shopRoot`} | The root; its State is the whole application's. |
| `/cart` | {rust: `Cart`}{ocaml: `cart`}{ts: `cart`} | Collects items; reports a checkout to its parent. |
| `/payments` | {rust: `Payments`}{ocaml: `payments`}{ts: `payments`} | Charges through the gateway Service. |

A checkout passes through every kind of message:

1. The **cart reducer** empties the cart and emits the Output
   {rust: `CheckedOut { total }`}{ocaml: `Checked_out { total }`}{ts: `{ kind: "cart.checked_out", total }`}.
2. The **root's lowerer** turns that Output into the root's own Action,
   `Pay { total }`.
3. The **root reducer** counts the order and sends `Charge { amount }` to
   its payments child.
4. The **payments reducer** makes a request ID, records the charge as
   pending under it, and emits the Effect
   {rust: `Charge { request, amount }`}{ocaml: `Charge_effect { request; amount }`}{ts: `{ kind: "payments.charge", request, amount }`}.
5. The **Effect handler** gives the gateway the charge and a reply to
   answer through. The gateway answers now or later{rust: , from any thread}{ocaml: , from any thread}{ts: , from a promise or a callback},
   and its Event waits on the bus until the application drains it.
6. The **payments adapter** turns the Event into the Action
   {rust: `Settled { request, approved }`}{ocaml: `Settled { request; approved }`}{ts: `{ kind: "payments.settled", request, approved }`}.
7. The **payments reducer** takes the pending charge and records it as
   paid.

In code, the application drives it from outside:

{{code checkout}}

The Store records each step as an execution, numbered in the order it ran,
with the execution that caused it. This is the trace of the run above:

| ID | Caused by | Category | Mount | Kind |
| --- | --- | --- | --- | --- |
| 1 | input | Action | `/cart` | `cart.add` |
| 2 | input | Action | `/cart` | `cart.checkout` |
| 3 | 2 | Action | `/` | `shop.pay` |
| 4 | 3 | Action | `/payments` | `payments.charge` |
| 5 | 4 | Effect | `/payments` | `payments.charge` |
| 6 | input, answering 5 | Event | `/payments` | `payments.charged` |
| 7 | 6 | Action | `/payments` | `payments.settled` |

The payments reducer is all of the payment logic. The request ID ties each
answer to its charge: the reducer makes it, keeps the charge in a `Pending`
table under it, and sends it with the Effect; the answer carries it back.

{{code reducer}}

A timeout would be one more Effect, asking the timer Service for an Event
later, and one more Action that takes the same request ID out of the table.
Whichever arrives first, the answer or the timeout, wins, and the other
finds nothing.

## Controlling one run

Components reach the world only through Services, so a test can give them
simulated ones. And since the Store runs one input at a time, the test
decides what happens next: which answer arrives, in which order, and when.

A test `Node` runs the real Store but holds every Event a Service sends
until the test delivers it. Here two charges are answered in the opposite
order:

{{code deliver-out-of-order}}

A hand-driven test is useful for a particular ordering. The generated test
above explores many such choices automatically. Several nodes can also
share a simulated network and one virtual clock; the [testing](testing.html)
page shows how to control both individual cases and generated runs.

## Seeing what happened

Every step the Store takes is an execution with its own ID, the execution
that caused it, where it ran and when, and an Event names the Effect it
answers. Observers see each one as it happens: a logger, statistics, a
trace, or your own. So a log can say not only what happened but why, back
to the input that started it.{rust: Watching is cheap: with the stock observers installed, an execution still allocates nothing.}
The [observability](observability.html) page shows how.

## What you write, and what causet does

| You write | Causet does |
| --- | --- |
| Message types, with {rust: derives}{ocaml: a deriver}{ts: descriptors} that name them | Runs every input to completion, in a fixed order |
| Each component's State and reducer | Checks whether each Action is allowed before it runs |
| Effect handlers and Services, for the I/O | Routes each answer to the component that asked |
| Adapters and lowerers, which translate | Numbers requests and stamps time from one clock |
| Possible test operations and invariants | Generates simulations, finds violations, shrinks failures and reproduces them from saved choices |

## When it fits

The cost is more explicit code: every asynchronous step is a named message,
and every lifecycle is State. That pays off when the hard parts are
ordering, timeouts, retries, cancellation and stale results, as in network
protocols, wallets and synchronization engines. An application whose hard
parts live in its database queries gains little from it.

## Reading on

1. [Messages](messages.html): declaring Actions, Effects, Events and
   Outputs, their kinds, nesting and what they log.
2. [Authority](authority.html): what each kind of code may read, change and
   start, and why the {rust: compiler}{ocaml: type checker}{ts: type checker} can enforce it.
3. [Scheduling](scheduling.html): the exact order in which work runs, how
   an Action is admitted or refused, and what {rust: a panic}{ocaml: an exception}{ts: an exception} does.
4. [Addressing](addressing.html): how components nest, how a parent calls a
   child, and where an Effect belongs.
5. [Running an application](running.html): starting a Store, driving it,
   Services on other threads, and assembling it by hand.
6. [Timeouts and retries](timeouts.html): deadlines, timers, and requests
   sent again.
7. [Determinism](determinism.html): the few rules application code must
   follow so a run can be repeated.
8. [Testing](testing.html): one transition, one node, generated runs, and
   several nodes on a simulated network.
9. [Observability](observability.html): what observers see, following a
   result to its cause, logging, statistics, reporting, and what they cost.
10. [Projections](projections.html): facts derived from an ordered log, kept
    right across restarts, and the checks for them.
