---
title: Determinism
summary: What application code must do so a run can be repeated.
---

A test is only as useful as its failures are repeatable. Causet can repeat
a run exactly: the same inputs lead to the same steps and the same end.
That is what lets a generated test shrink a failing run and hand you a
seed that reproduces it, every time. Causet does most of the work, and
application code keeps a few rules about iteration order, time,
randomness and I/O. This page states what exactly is repeated, and lists
those rules.

From the same starting State, given the same inputs and the same clock
readings, a Store runs the same executions in the same order, at the same
times, and ends with the same State, with one exception: each Store run has
its own {rust: session (`SessionId`)}{ocaml: session}{ts: session (`SessionId`, a number)}, which every request ID and reply
route carries, so that an answer meant for another run is told apart.
State that holds request IDs therefore differs between two runs in their
session, and nowhere else; compare such State with that in mind.

::: ocaml
`Event_bus.create` gives each bus a fresh session; `Event_bus.with_session`
takes one, so a test can fix it.
:::

::: ts
`eventBus` gives each bus a fresh session unless its options name one,
`{ session }`, so a test can fix it.
:::

That is what makes a test reliable, a failure reproducible, and a simulated
run repeatable from its seed. Causet keeps its side: the order work runs in
is fixed ([scheduling](scheduling.html)), every time an execution sees
comes from the Store's clock, and request IDs are numbered within
executions. The application keeps the other.

{{code repeat-run}}

A request still pending at the end shows the exception:

{{code pending-session}}

## The rules

Code that runs inside the Store (enabling checks, guards, reducers,
lowerers, adapters) must follow these:

- **Iterate State in a fixed order.** {rust: Use `BTreeMap`, `BTreeSet`, a `Vec` or an insertion-ordered map. Never let `HashMap` or `HashSet` iteration decide what is emitted or how State changes: their order differs between runs, so the same inputs would lead elsewhere. `RequestId`, `InstanceId` and `ExecutionId` are `Ord` for this reason.}{ocaml: Use `Map`, `Set`, a list or an array. Never let `Hashtbl` iteration decide what is emitted or how State changes: its order depends on hashing and on the table's history, so the same inputs could lead elsewhere. Request IDs, instance IDs and execution IDs have a total order for this reason.}{ts: Use an array, a `Map` or a `Set`, which iterate in insertion order, or causet's `SortedMap` and `SortedSet`, which iterate in key order, as the other ports' ordered maps do: use those where a run is compared with another port's. Never let a plain object's key order decide: keys that look like integers come first, in numeric order, and the rest in insertion order. Execution IDs are numbers, instance IDs `bigint`s, and `RequestId.compare` orders request IDs, for this reason.}
- **Read the time from metadata,** `meta.time`, or the `now` an enabling
  check receives. Never read the system clock.
- **Draw randomness from a seeded generator kept in State,** never from {rust: the thread}{ocaml: the global `Random` state}{ts: `Math.random()`} or the operating system.
- **Do no I/O and keep no state outside State:** no files, network, globals, {rust: thread-locals}{ocaml: domain-local storage}{ts: module-level variables} or environment variables. I/O belongs to Services, and what they learn comes back as Events.
- **Stay bounded.** Long work advances through small follow-up Actions;
  expensive computation runs behind a Service.

::: ts
JavaScript has a few more ways in which code breaks these rules without
meaning to:

- `Date.now()`, `new Date()` and `performance.now()` read the system clock;
  `Math.random()`, `crypto.getRandomValues()` and `crypto.randomUUID()` the
  operating system's randomness.
- `localeCompare`, `Intl` and `toLocaleString` follow the machine's locale,
  so the same strings may sort or print differently on another machine.
  `<` compares strings by UTF-16 code unit, and `SortedMap`'s natural order
  by code point, as Rust and OCaml order their strings.
- Whatever a promise, `await`, `setTimeout` or `queueMicrotask` schedules
  runs after the execution has ended, outside it. A reducer, an Effect
  handler, an Event adapter, an Output lowerer or an observer that returns
  a promise faults the Store, and a `register` that returns one is a
  problem `freeze` reports; work that waits belongs to a Service, whose
  answer comes back as an Event.
- State is immutable by convention: its types are `Readonly`, but nothing
  stops code from changing an array or an object in place. A change made
  that way is not a new State, and is shared with every snapshot that
  holds the same object.
:::

Effect handlers and Services are the boundary: whatever is not
deterministic about the world (timing, failures, the order answers arrive
in) enters only as the Events they send. A test or a simulation controls
them, and so controls the run.

## The clock

Each Store has one {rust: `Clock`, given in `StoreOptions`}{ocaml: `Causet.Clock.t`, given to `Store.create`}{ts: `Clock`, given as the `clock` of `Store.create`'s options}: the only source of execution IDs and `meta.time`.
{rust: `SystemClock`}{ocaml: `Clock.system`}{ts: `systemClock()`}, the default, gives
nanoseconds since the Unix epoch: the system time at start, advanced by the
monotonic clock, plus any stretch the monotonic clock missed, such as a
device's sleep, which it notices as the system clock gaining on it. A
system clock stepped back is ignored. An application that knows the
machine's error (from NTP, a server, GPS) corrects it with a
{rust: `ClockOffset`}{ocaml: `Clock.Offset`}{ts: `ClockOffset`}. {rust: `ManualClock`}{ocaml: `Clock.Manual`}{ts: `ManualClock`}
moves only when told, for tests. Every execution is stamped
{rust: `max(previous, now)`}{ocaml: `max previous now`}{ts: `Math.max(previous, now)`}, so times never go
back whatever the clock does; the execution IDs, which count executions,
order the run.

{{code stamps}}

{{code stamps-run only=ocaml,ts}}

::: ts
Times are nanoseconds since 1970 in a `number`, as in the other ports, and
a `number` holds every whole number exactly only up to 2^53: about 104 days
of nanoseconds. A manual clock in a test stays below that, and is exact.
The system clock reads near 1.7 × 10^18 ns, where a `number` steps by 256 ns:
its readings, and the deadlines compared with them, are exact to 256 ns,
and `Math.max(previous, now)` still never goes back. The wall clock it
starts from, `Date.now()`, is in whole milliseconds; the monotonic clock
that advances it is `performance.now()`.
:::

Services may keep their own clocks for their I/O, as the
{rust: `Timer`}{ocaml: `Causet.Timer`}{ts: `Timer`} does; reducers only ever see the
Event that results.

## Request IDs

{rust: `ComponentContext::new_request`}{ocaml: `Ctx.new_request`}{ts: `ctx.newRequest()`} numbers
requests within the current execution and stamps them with the session and
the execution's ID, so a repeated run makes the same IDs except for the
session, which tells two runs' answers apart. A reducer stores one, puts it
in an Effect, and matches the answer.

## Serializing State

::: rust
Messages need no serialization. An application that wants to save State (a
fixture, a diagnostic dump) derives `serde` on its own types, and enables
causet's `serde` feature for the identity types State holds, such as
`RequestId`.
:::

::: ocaml
Messages need no serialization: they travel as typed values. An application
that wants to save State (a fixture, a diagnostic dump) serializes its own
types, request IDs included, which are plain records of integers.
:::

::: ts
Messages need no serialization: they travel as values. An application
that wants to save State (a fixture, a diagnostic dump) serializes its own
types. A `RequestId` is a class of three numbers, which `JSON.stringify`
writes as `{"session":1,"execution":2,"index":3}` and
`new RequestId(session, execution, index)` makes again. `Pending`,
`SortedMap` and `SortedSet` keep their entries in private fields, which
`JSON.stringify` writes as `{}`: an application saves their entries, and
builds the tables again from them.
:::
