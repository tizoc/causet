---
title: Projections
summary: Facts derived from an ordered log of records, with bounded context, a warm-up after a restart, and checks that a restart or an incremental shortcut changes nothing.
---

An application that stores records, such as the reports its nodes send,
wants facts from them: an alert when a source fails three times in a
minute, or where each block a node produced ended up. The records arrive
late and out of order, and the process that derives the facts restarts.
Deriving everything again from the first record after every restart is
slow, and the log may not be kept that long. Remembering everything in
memory is lost on the restart itself.

A projection derives facts from the log one record at a time, in log order,
and keeps only a window of recent context. After a restart it is warmed up
from that window of the stored log, and it then outputs exactly what it
would have without the restart. That property, and the shortcut a
projection takes to stay fast, each have a check a test can run. The
projections are in {rust: `causet::projection` (the `causet-projection` crate)}{ocaml: `Causet_projection` (the library `causet.projection`)}{ts: `causet/projection`}.
Storing the records, the outputs and the cursor stays the application's
work, with a few rules this page states.

## A projection

A projection has a name, for diagnostics, a retention, and a function that
processes one record and gives what it derives from it.

::: rust

It is a type implementing `Projection<R>`, for records of type `R`, with
`name`, `retention_ms` (`None` unless overridden) and
`process(&mut self, record, out)`, which pushes its outputs into `out`. A
record implements `LogEntry`: its `time_ms` is its event time, when it
happened rather than when it arrived. Every output implements `Keyed`.

:::

::: ocaml

It is a record `{ name; retention_ms; process }`, made with
`projection ?retention_ms ~name process`, where `process` takes one record
and returns its outputs in order. Its State lives in the closure. A
record's event time, when it happened rather than when it arrived, is read
by a function the `Projector` is given.

:::

::: ts

It is an object implementing `Projection<R, O>`, for records of type `R`
and outputs of type `O`: a `name`, a `retentionMs` (absent unless given)
and `process(record)`, which returns its outputs in order. Its State is its
own: a class's fields or a closure's variables. A record's event time, when
it happened rather than when it arrived, is read by a function the
`Projector` is given.

:::

Each output has a key, which is an idempotency key: the same derivation
always gives the same key and value, so writing an output twice is
harmless. {ocaml: The output type is free; `check_incremental` is told how to read its key.}{ts: The output type is free; `checkIncremental` is told how to read its key.}

The retention is how far back in event time the projection's context
reaches. A warm-up feeds it the stored records of that window again. A
projection with no retention keeps no context, and is not warmed up.

A projection follows the [determinism](determinism.html) rules: ordered
collections, no I/O, no wall clock. Its only time is the records' own, so
it measures its window from the newest event time it has seen, never from
the record at hand, which may be late.

Here a projection reports a burst whenever a source has failed three times
within a minute. It keeps each source's failures of the last minute, and
drops what is older, so it keeps nothing that a warm-up would not feed back:

{{code bursts}}

## The Projector

A {rust: `Projector`}{ocaml: `Projector.t`}{ts: `Projector`} feeds each record to its
projections in the order they were added, and returns what they derive in
that order. All its projections derive outputs of one type.
{rust: `new`, `add_projection`, `process` (or `process_into`, which pushes into a vector of your own), `names` and `max_retention_ms`}{ocaml: `Projector.create ~time`, `add`, `process`, `names` and `max_retention_ms`}{ts: `new Projector(time)`, `add`, `process`, `names` and `maxRetentionMs`}
are its everyday calls. The others warm it up.

## After a restart

A restart rebuilds context, never history. The application starts a new
{rust: `Projector`}{ocaml: projector}{ts: `Projector`} and asks
{rust: `warm_up_from(last_time_ms)`}{ocaml: `Projector.warm_up_from projector last_time_ms`}{ts: `warmUpFrom(lastTimeMs)`},
where {rust: `last_time_ms`}{ocaml: `last_time_ms`}{ts: `lastTimeMs`} is the latest event time among the records up to its
cursor. Each projection's window then starts that far before it, by its
retention, and the call returns the earliest of them: the event time from
which to read the stored log. It returns {rust: `None`}{ocaml: `None`}{ts: `undefined`} when no projection keeps
context.

The application then feeds the stored records to {rust: `warm`}{ocaml: `Projector.warm`}{ts: `warm`},
in log order, the order live processing saw them. Each record reaches only
the projections whose window it falls in, and what they derive from it is
dropped: a replayed record may lack context older than the window, so its
outputs can differ from those stored, and must not overwrite them. For a log
held in memory, {rust: `warm_up`}{ocaml: `Projector.warm_up`}{ts: `warmUp`} does the
whole warm-up over the records up to the cursor.

{{code warm-up}}

The projection crate does not store anything. Storage, the cursor,
checkpoints and delivery are the application's, and these rules keep them
sound:

- A record's outputs are stored before, or atomically with, the cursor's
  advance past it, and processing resumes strictly after the cursor.
- An application that stores outputs first and advances the cursor
  separately writes some outputs again after a crash. That is safe only if
  its writes are duplicate-safe, by the outputs' keys, and the projection
  passes the restart check below.
- What a warm-up derives is dropped, never stored.
- Rebuilding outputs, for a new or corrected projection, is possible only
  where their records are still stored: from the log's beginning, or from a
  checkpoint.

::: rust

With its `reporting` feature, the `causet-projection` crate implements
`LogEntry` for the reporting pipeline's `Record`, so a projection can read
the stored [reports](observability.html#reporting) as they are, by their
`timestamp_ms`.

:::

## Checking restarts

A projection is sound across restarts when a restart changes nothing it
outputs. {rust: `check_restarts(fresh, records, restarts)`}{ocaml: `check_restarts fresh records restarts`}{ts: `checkRestarts(fresh, records, restarts)`}
checks it: it runs `records` through a fresh projector once without a
restart, then once more, restarting before each index in `restarts`, one
after another, each time with a fresh projector warmed up from the records
before it. It returns the first record whose outputs differ, as a
{rust: `Difference`}{ocaml: `difference`}{ts: `Difference`, the `error` of a result whose `ok` is false}: `record`, its index, `expected`
and `actual`, its outputs in the two passes, and `restart`, the cursor of
the latest restart before it. A `restart` of {rust: `None`}{ocaml: `None`}{ts: `undefined`} means the passes
differed with no restart at all: the projections are not deterministic.
{ocaml: `pp_difference` prints one, and `?equal` compares outputs when `(=)` cannot.}{ts: `differenceMessage` prints one. Outputs are compared structurally (`structuralEqual`, as the other ports compare them), unless the `equal` option says how.}

A retention shorter than what the projection reads is the usual mistake.
Here a copy of the burst projection says it keeps 30 seconds; restarted
after the record at 80 s, it is warmed up from 50 s on, and misses a
failure it needed:

{{code check-restarts}}

An application whose restart does more, such as seeding a projection from a
checkpoint before the warm-up, checks its own with
{rust: `check_restarts_with(fresh, restarted, records, restarts)`}{ocaml: `check_restarts_with fresh restarted records restarts`}{ts: `checkRestartsWith(fresh, restarted, records, restarts)`},
where `restarted` is given the records up to the cursor and returns the
projector ready to go on. A warm-up that sorted the stored records by event
time, for instance, while live processing kept log order, is one this check
finds. The restart points are best generated, with the
[generated runs](testing.html#generated-runs) of the testing page, as
chain placement's tests do.

## Checking incremental recomputation

A projection that keeps many keys does not recompute all of them on every
record: it recomputes only the keys it judges the record to change. A
missed key leaves a stale output, and context evicted while a key that
reads it is still maintained makes a later recomputation lose facts.
Restart equivalence finds neither when the uninterrupted pass is wrong the
same way.

{rust: `check_incremental(projection, reference, records, recompute)`}{ocaml: `check_incremental ~key ~projection ~reference ~recompute records`}{ts: `checkIncremental({ projection, reference, records, key, recompute })`}
checks the shortcut. It feeds every record to the projection and to a
reference, usually the same projection keeping everything it sees, keeps
each key's last output as the application would store it, and after each
record asks `recompute` for each stored key's output now. The first stored
output that differs is returned as a {rust: `Mismatch`}{ocaml: `mismatch`}{ts: `Mismatch`}:
the index of the record after which they differ ({rust: `record`}{ocaml: `m_record`}{ts: `record`}),
the `key`, the output `stored` and the one `recomputed`.

Here, each id's sightings within a minute of the newest one are counted. A
projection that recomputes only the id of the record at hand leaves another
id's count stale when the minute moves past its sightings:

{{code check-incremental}}

`recompute` returns {rust: `None`}{ocaml: `None`}{ts: `undefined`} for a key the projection no longer maintains
(one it evicted, or an output made once and never revised): such a key is
not compared. Nor is a key the projection never output: one that outputs
nothing passes. A test checks that the keys expected are output as well,
for example by running the projection over the log itself and reading what
it outputs.

## A real one: chain placement

{rust: `examples/chain-placement`}{ocaml: `examples/chain_placement`}{ts: `examples/chain-placement`} is a
projection of a chain's stored reports into each block's placement. Nodes
report the blocks they produce and the tips they adopt, late and out of
order. For each produced block, the projection finds its facts in the
reports around it by event time (the chain's height then, whether its
parent was seen, who else adopted it, which blocks competed for its slot)
and classifies it as `canonical`, `orphaned`, `likely_main_chain`,
`likely_side_chain`, `stale_parent` or `unknown`. It outputs a block's
status, keyed by its block, whenever the status changes, and its placement
once, when the chain's progress makes it final.

It keeps blocks a fixed retention behind the newest event time, and the
chain reports a kept block may still read, so its declared retention is
that retention plus how far back a block reads. After each record it
recomputes only the blocks the record may have changed.
{rust: `ChainPlacement::unbounded()`}{ocaml: `Projection.unbounded ()`}{ts: `ChainPlacement.unbounded()`},
the same projection keeping everything, is the reference for
`check_incremental`, and {rust: `status_now`}{ocaml: `Projection.status_now`}{ts: `statusNow`}
recomputes a key. Its tests generate chains, nodes and late reports, and
check restarts, incremental recomputation and the output's contract; what
generation found is pinned in its findings tests.
