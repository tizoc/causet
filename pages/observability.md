---
title: Observability
summary: Every step a Store takes, with its cause, for logs, traces, statistics and your own tools; reports for errors and metrics; and what it all costs.
---

When an asynchronous system misbehaves, the hard question is why: which
input led to this state, which request an answer belonged to, what ran in
between. In most code that history is gone by the time you look, or spread
over log lines from different threads with nothing to join them on.

In causet it is part of how the Store runs. Every step is an *execution*
with its own ID, the execution that caused it, where it ran and when, and an
Event names the Effect it answers. Observers see each execution as it
happens, so a log line, a trace or a dashboard can say not only what
happened but what caused it. Watching changes nothing: an observer reads,
and cannot dispatch, emit or change State.

Beside observers, a reporting pipeline turns what the application decides
is worth reporting (errors, metrics, events, healthchecks) into records
ready to send, with deduplication, rate limits, sampling and metric
aggregation.

This page covers what an observer sees, how to follow a result back to its
cause, logging and statistics, checking invariants as the Store runs,
reporting, and what all of it costs.

## What an observer sees

An observer is a set of callbacks the Store calls at each boundary of a run
(the [lifecycle](scheduling.html#lifecycle)). In Rust it is a type
implementing the `Observer` trait, whose methods all default to nothing;
in OCaml it is an `Observe.t` record of functions, and `Observe.none` does
nothing.
{ts: In TypeScript it is any object of the `Observer` interface,
whose callbacks are all optional and named in camelCase: `actionStart`,
`actionRefused`, `inlineAction` and so on.}
{ocaml: The Store calls only the callbacks an observer does not leave as
`Observe.none`'s.}{ts: The Store calls only the callbacks an observer has
when it is added.}

| Callback | When |
| --- | --- |
| `action_start`, `effect_start`, `event_start` | An execution starts. Its payload is still readable. |
| `action_finish`, `effect_finish`, `event_finish` | Its handler returned; what it queued has not run yet. |
| `action_settled`, `event_settled` | Everything it caused has finished or been refused. |
| `action_refused` | An Action was refused at admission: what refused it, and where it was sent from. |
| `inline_action` | A child's Action runs inline, within its parent's execution. |
| `bug`, `fault` | A bug was reported; the Store faulted. |
| `bus` | The Event bus's depths, at the start of a drain. |

Each execution comes with its metadata: its ID (a Store numbers executions
1, 2, 3 in the order they start), its time, its depth, its origin (the
execution that emitted it, and how), the path and instance of the mount it
ran on, and its message's type and kind. Only start callbacks see the
payload: after that, its handler owns it.

{rust: A panic}{ocaml: An exception}{ts: A throw} in an observer faults the Store, like
one anywhere else in a run, except in `bug` and `fault`, which report
something already decided.

Here an observer writes one line per execution: its ID, the execution that
caused it, its kind and where it ran. The checkout from the
[overview](index.html#one-checkout-step-by-step) produces seven:

{{code custom-observer}}

## Following a result to its cause

{rust: `TraceLog`}{ocaml: `Observe.Trace_log`}{ts: `TraceLog`} keeps every execution, every
refusal and every inline call, in order. Because each step names its
cause, a question such as "why was this charge settled?" has an exact
answer: walk back from the result to the input that started it. The chain
crosses the gap where the gateway worked on a thread of its own, because
the Event names the Effect it answers.

{{code why-chain}}

The same walk is how a test explains a failure, and how a log line can carry
the whole story of a request: the root input, and every step between it and
the line.

## Logging

{rust: `causet::observers::Logger`}{ocaml: `Causet_observers.logger`}{ts: `Logger`, from `causet/observers`,} logs
every execution as it starts, through {rust: `tracing`, on the target
`causet::exec`}{ocaml: `Logs`, on the source `causet.exec`}{ts: a `LogSink`, on the target `causet.exec`}: the scheduler
time, an optional label (a node's name, say), the category, type, kind,
destination path, metadata and the message's chosen fields. A refused Action
is logged with what refused it and where it came from, a child's Action run
inline with its parent's execution and time.

::: ts
JavaScript has no standard logging library like Rust's `tracing` or
OCaml's `Logs`, so the logger writes to a `LogSink`, an interface of two
methods: `enabled(level, target)`, asked before a record is built, and
`log(record)`, which takes one record (its level, target, message, and
fields in order). An application adapts it to the logging it uses in a few
lines. `setLogSink` sets the sink that every logger without its own writes
to, and until it is set nothing is logged. `consoleSink()` writes each
record to the console as one line, `MemorySink` keeps them for a test, and
`new Logger({ sink, label })` gives one logger a sink of its own and a
label.
:::

Each message type chooses the level it is logged at and which of its
fields appear, per type or per variant, so a log shows what matters and
leaves out what must not be logged:

{{code log-attributes}}

Reducers and handlers never read the system clock, so their own log lines
are stamped with the execution's time:
{rust: `causet::observers::info!(meta.time; job = id, "stale job")`}{ocaml: `Causet_observers.log_at Logs.Info ~time:meta.time "stale job %d" id`}{ts: `logAt("info", meta.time, "stale job", { job: id })`}.
A log from a simulated run then reads in simulated time, and lines up with
the trace.

## Statistics

{rust: `causet::observers::Stats`}{ocaml: `Causet_observers.Stats`}{ts: `Stats`, from `causet/observers`,} counts
executions and their durations by category, type and kind, in nine ranges
from under 1 µs to over 50 ms. A snapshot is plain data; serving it, as
metrics or a status page, is the application's business.

{{code logger-and-stats}}

## Invariants in production

An observer sees steps; an invariant judges the State they leave. A Store
can check the application's own invariants as it runs, in production as
in a test: {rust: `Store::add_invariant`}{ocaml: `Store.add_invariant`}{ts: `store.addInvariant`}
takes a name and a checker, which reads the whole State and says what is
wrong with it, if anything.

A checker runs once as it is added, then after every root input that
settles: an admitted Action dispatched to the Store, or one drained Event,
each with everything it caused. It does not run after a refused Action or
an empty drain, nor once the Store has faulted, and it never sees the
steps inside a root input, only the State between two of them.

A violation is a [bug report](scheduling.html#bug-reports), not a fault.
It reaches observers at phase {rust: `Phase::Invariant(name)`}{ocaml: `Invariant name`}{ts: `{ kind: "invariant", name }`},
placed at the root input it settled after (at none as it is added), with
the invariant's name as a
field and its registration as the source
({rust: the caller of `add_invariant`}{ocaml: the position passed as its `?pos`}{ts: the caller of `addInvariant`, read from the stack}).
The Store goes on, and checks again after the next root input: a State
that stays wrong is reported each time. A checker that
{rust: panics}{ocaml: raises}{ts: throws} does not fault the Store either: it is
reported at {rust: `Phase::InvariantPanic(name)`}{ocaml: `Invariant_panic name`}{ts: `{ kind: "invariantPanic", name }`}
and disabled, since what it remembers may be half updated.

Here the shop's orders must all be accounted for: each one paid, declined
or still pending. A charge sent straight to payments, with no order behind
it, breaks that, and a {rust: `BugLog`}{ocaml: `Observe.Bug_log`}{ts: `BugLog`} catches
the report:

{{code invariant-orders}}

A checker can remember earlier steps: {rust: what its closure captures}{ocaml: what its closure holds, such as a `ref`}{ts: what its closure holds, such as a `let`}
is its memory, and it is told why it runs, as
{rust: an `InvariantStep`: `Added`, `Restored` (moved into a new Store) or
`Settled`}{ocaml: an `invariant_step`: `Added`, `Restored` (put back by
`Causet_test` as a node restarts) or `Settled_step`}{ts: an `InvariantStep`: `{ step: "added" }`,
`{ step: "restored" }` (moved into a new Store, as `Node.restart` does) or
`{ step: "settled" }`}, the last with the root input's execution,
category, path, kind and time. This one checks that no paid charge is ever
forgotten, which no single State can show, and reports each loss once:

{{code invariant-memory}}

That memory lives in the checker, so it can outlast the Store.
{rust: `Store::take_invariants`}{ocaml: `Store.take_invariants`}{ts: `store.takeInvariants()`} takes the
invariants out, with what they remember, for the Store that replaces this
one, say one rebuilt from a snapshot after a fault;
{rust: `Store::restore_invariants`}{ocaml: `Store.restore_invariants`}{ts: `store.restoreInvariants`} moves
them into the new Store and runs each on its State as {rust: `Restored`}{ocaml: `Restored`}{ts: `restored`}, before
any root input. One disabled in the old Store stays disabled. Here the new
Store starts from a stale snapshot, and the invariant notices what it lost:

{{code invariant-restart}}

The memory moves between Stores in one process; it does not survive the
process.

::: ocaml

A set of invariants taken from one Store goes to one other Store only: the
types cannot stop it being given twice. Adding the same checker again
works too, since its memory is in what its closure holds; it then runs as
`Added`, not `Restored`, and one disabled in the old Store runs again:

:::

::: ts

A set of invariants taken from one Store goes to one other Store only: the
types cannot stop it being given twice. Adding the same checker again
works too, since its memory is in what its closure holds; it then runs as
`added`, not `restored`, and one disabled in the old Store runs again:

:::

{{code invariant-readd only=ocaml,ts}}

With no invariant, the Store checks nothing; with some, it runs every
checker on the whole State after each root input, so their cost is their
own. Tests check invariants the same way and stop at a violation; the
[testing](testing.html) page covers them.

## Reporting

Observers see every step; most of them are not worth sending anywhere. A
report is what the application decides is: an error, a measurement, a
notable event, a healthcheck. The reporting pipeline,
{rust: the `causet-reporting` crate}{ocaml: the `causet-reporting` package}{ts: the `causet-reporting` package},
takes each report and decides whether it goes out:

- **Deduplication** drops a report seen again within a window (five
  seconds by default, for errors), by its dedupe key or its content.
- **Rate limits** keep at most so many reports per source in any window.
- **Sampling** keeps a share of each kind, decided by the report's hash, so
  the same report is always kept or always dropped, in every run.
- **Metric aggregation** folds a metric's numeric fields over a window into
  one report: count, minimum, maximum, average, p50 and p95 (by nearest
  rank: the p95 of four values is the largest, and a NaN ranks above
  every number) and a sample of values, with counts for the fields it
  groups by.
- **Records** come out numbered, stamped and ready to write as one JSON
  line each; a dump writes them to files rotated by size, and a context
  trail keeps the last steps of a workflow to attach to an error.

The pipeline knows nothing of the Store. An application wires it in as a
Service: the reducer emits an Effect that says, as plain data, what
happened; the Effect handler builds the report and hands it to the
pipeline, stamped with the execution's time; and the application delivers
the records however it likes. Reports are built in one place, the handler,
so the reducer stays a pure transition.

{{code report-service}}
{{code report-service-run only=ocaml,ts}}

Two failures for the same reason within the dedupe window make one record:

{{code report-dedupe}}

A record is one JSON object, with the pipeline's run ID on its first record
(here it varies from run to run):

```text
{"id":1,"timestamp_ms":1000,"kind":"error","source":"payments","payload":{"run_id":"28Sqb3m9uz2","event":"charge_declined","amount":30,"reason":"insufficient_funds"}}
```

A metric policy can aggregate a measurement instead of sending each one.
Here four checkouts become one report when the minute is up:

{{code report-aggregate}}

```text
{"id":1,"timestamp_ms":61000,"kind":"metric","source":"pipeline","payload":{"run_id":"28Sqb3mBYBE","event":"metric_aggregate","window_ms":60000,"window_start_ms":1000,"metric":{"source":"shop","event":"checkout"},"fields":{"took_ms":{"count":4,"min":80,"max":300,"avg":148.75,"p50":95,"p95":300,"samples":[120,80,95,300]}},"groups":{"ok":{"false":1,"true":3}}}}
```

The whole configuration reads from JSON ({rust: through `serde`}{ocaml: `Config.of_json`}{ts: `configFromJson`, or `parseConfig` from text}),
and every section has defaults, so `{}` is a valid configuration. Every
port makes the same records from the same reports: the OCaml and
TypeScript pipelines reproduce the Rust one's test transcript record for
record.

## What it costs

With no observer installed, the Store skips every callback, and reads no
message kind for refusals and inline calls. {ocaml: The same goes for each
boundary no observer has a callback for: it costs nothing.}{ts: The same
goes for each boundary no observer has a callback for: it costs nothing.}

::: rust

With observers installed, the Rust port still allocates nothing per
execution. An observer gets borrowed views of the execution and its
payload, and `Logger` and `Stats` keep no buffer per execution. Measured
with `cargo bench -p causet --bench baseline` on an Apple M3 Max, rustc
1.90, per execution:

| Scenario | ns | Allocations |
| --- | ---: | ---: |
| queued Action, no observer | 61.8 | 0 |
| queued Action, `Stats` | 65.3 | 0 |
| queued Action, `Logger`, logging off | 58.6 | 0 |
| refused Action, no observer | 12.4 | 0 |
| refused Action, `Stats` | 20.2 | 0 |
| refused Action, `Logger`, logging off | 20.6 | 0 |
| inline child call, no observer | 9.4 | 0 |
| inline child call, `Logger`, logging off | 11.8 | 0 |

"Logging off" means no subscriber wants the `causet::exec` target: the cost
of leaving the logger installed in production, which is within noise of
having none. With logging on, the cost is the subscriber's.

The Store itself makes no allocation per execution in these benchmarks:
queued messages travel inline up to 48 bytes, and only a larger payload is
boxed when queued.
`TraceLog` keeps every execution, so it grows with the run: it is meant for
tests and debugging.

Reports are built in a pooled buffer (`causet-pooled-payload`): a field is
written into a reused byte pool and kept as an offset, so building a
report allocates nothing once the pool has grown. Accepting one allocates
nothing either, aggregated metrics included: an aggregate's windows are
set up when the pipeline is made, and allocate only when a window closes
into its report. A report is hashed with BLAKE3 only when a step needs it
(deduplication, or sampling at a rate between 0 and 1), and that hash is
most of what a deduplicated report costs. Measured with
`cargo bench -p causet-reporting --bench accept`, per report:

| Report | ns | Allocations |
| --- | ---: | ---: |
| build an error report | 41 | 0 |
| build and accept, kept | 76 | 0 |
| build and accept, deduplicated | 233 | 0 |
| build and accept, aggregated | 437 | 0 |

:::

::: ocaml

Observers cost more in the OCaml port, where every execution allocates on
the minor heap and a callback is a closure call. Measured with
`dune exec --profile release bench/baseline.exe` on an Apple M3 Max, per
execution:

| Scenario | ns | Minor words |
| --- | ---: | ---: |
| queued Action, no observer | 82.1 | 114 |
| queued Action, `Stats` | 142.7 | 140 |
| queued Action, `logger`, logging off | 97.4 | 130 |
| refused Action, no observer | 30.4 | 36 |
| refused Action, `Stats` | 31.2 | 36 |
| refused Action, `logger`, logging off | 46.2 | 57 |
| inline child call, no observer | 37.3 | 57 |
| inline child call, `logger`, logging off | 51.1 | 83 |

`Stats` has start callbacks only, so a refusal costs it nothing.

"Logging off" means the `causet.exec` source is set to log none of the
messages: the logger then costs a level check per execution, beside the
callbacks themselves. `Observe.Trace_log` keeps every execution, so it
grows with the run: it is meant for tests and debugging.

A report's payload is built as a small tree, with no pool. A report is
hashed with BLAKE3, written in OCaml, only when a step needs it
(deduplication, or sampling at a rate between 0 and 1); that hash is most
of what a deduplicated report costs. Measured with
`dune exec --profile release bench/reporting.exe`, per report:

| Report | ns | Minor words |
| --- | ---: | ---: |
| build an error report | 20 | 91 |
| build and accept, kept | 51 | 113 |
| build and accept, deduplicated | 487 | 119 |
| build and accept, aggregated | 913 | 171 |

:::

::: ts

Observers cost more in the TypeScript port, where every execution
allocates on V8's young heap. Measured with `pnpm --filter causet bench`
(`bench/baseline.ts`) on an Apple M3 Max, Node 24.22, per execution. V8
cannot count allocations, so the bench reads the bytes allocated off the
heap's growth over a round in which no collection runs:

| Scenario | ns | Bytes |
| --- | ---: | ---: |
| queued Action, no observer | 169.6 | 363 |
| queued Action, `Stats` | 215.9 | 486 |
| queued Action, `Logger`, logging off | 193.0 | 485 |
| refused Action, no observer | 52.2 | 4 |
| refused Action, `Stats` | 56.4 | 5 |
| refused Action, `Logger`, logging off | 78.9 | 235 |
| inline child call, no observer | 82.4 | 196 |
| inline child call, `Logger`, logging off | 97.1 | 211 |

`Stats` has start callbacks only, so a refusal costs it nothing.
"Logging off" means the log sink, here the default one, keeps nothing at
the message's level: the logger then costs a level check per execution,
beside the callbacks themselves. `TraceLog` keeps every execution, so it
grows with the run: it is meant for tests and debugging.

A report's payload is built as a small tree of objects, with no pool. A
report is hashed with BLAKE3, written in TypeScript on 32-bit words, only
when a step needs it (deduplication, or sampling at a rate between 0 and
1); that hash is most of what a deduplicated report costs. Measured with
`node bench/accept.ts` in `causet-reporting`, per report:

| Report | ns | Bytes |
| --- | ---: | ---: |
| build an error report | 33 | 785 |
| build and accept, kept | 53 | 880 |
| build and accept, deduplicated | 496 | 879 |
| build and accept, aggregated | 936 | 805 |

:::
