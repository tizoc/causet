---
title: Timeouts and retries
summary: Timers as Services, requests that wait with deadlines, retries whose late answers are stale, and timeout tests that never sleep.
---

A request sent over a network may be answered late, twice, or never. Code
that waits for it usually needs a callback for the answer, a timer for the
timeout, a flag they share to decide which came first, and a retry that must
not be confused by the first attempt's answer when it finally arrives. Each
piece runs on its own schedule, and the races between them are where the
bugs are.

In causet a timeout is an Event, like the answer. A reducer asks the timer
Service for one, pinned to the request it times out; the answer and the
timer then reach the same reducer, one at a time, in the order the Store
runs them. Whichever arrives first ends the request. The other finds
nothing and is stale, and the reducer ignores it. A retry is a new request
with a new ID, so a late answer to the old one is stale too.

This page covers the timer Service, a timeout per request, retries,
testing a timeout without waiting for it, keeping requests in `Pending`,
and one timer for many deadlines.

## The timer Service

{rust: `Timer`}{ocaml: `Causet.Timer`}{ts: `Timer`} is a Service like any other. An
Effect handler arms it with a delay, a reply and a request ID:
{rust: `timer.after(delay, reply, request)`, where the delay is a `Duration`}{ocaml: `Timer.after timer ~delay reply request`, where the delay is in nanoseconds}{ts: `timer.after(delay, reply, request)`, where the delay is in nanoseconds}.
When the delay has passed, it sends
{rust: `TimerFired { request }`}{ocaml: a `Timer.fired`, `{ request }`}{ts: a `TimerFired`, `{ kind: "causet.timer_fired", request }`},
of Event type `causet.timer_fired`, through the reply, into the worker
lane. It reaches the mount whose Effect made the reply, so one timer can
serve several mounts. Timers due at the same instant fire in the order they
were set. Arming never blocks.

The request is whatever the reducer pinned the timer to, usually the ID of
the request it times out. Nothing cancels a timer once it is set: when the
answer comes first, the timer's Event finds its request no longer pending
and is stale. That is how a timeout is cancelled.

A component adapts the Event as it adapts any other:
{rust: it registers it with `r.event::<TimerFired>()` and implements `Adapts<TimerFired>`}{ocaml: it registers `Timer.fired` with `Registrar.event`}{ts: it registers `timerFired` with `r.event(timerFired, adapt)`},
turning it into one of its own Actions.

{rust: On native targets, `Timer::new()` starts a thread that waits}{ocaml: `Timer.create ()` starts a thread that waits}{ts: `Timer.create()` makes one that waits, through `setTimeout`,}
for the deadlines on its own monotonic clock, not on the Store's.
Services may keep their own clocks for their I/O; reducers only ever see
the Event, and read the time from the execution, as always
([the clock](determinism.html#the-clock)). When the worker lane is full,
{rust: the thread waits for room}{ocaml: the thread waits for room}{ts: the timer waits for room, 10 ms at a time},
and the timers due after it wait too.
{rust: Dropping the `Timer`, with the Services that own it, stops the thread and drops the timers that have not fired.}{ocaml: `Timer.stop` stops the thread, and the timers that have not fired never will; after it, `after` sets nothing. Native socket wakeups work on Unix and Windows without a descriptor-number limit.}{ts: `timer.stop()` clears its `setTimeout`, so it keeps nothing alive, and the timers that have not fired never will; after it, `after` sets nothing.}

### Timers driven by the host

A host with its own event loop can use
{rust: `Timer::driven(clock)`}{ocaml: `Timer.driven clock`}{ts: `Timer.driven(clock)`}
with any clock. It returns the same timer Service and a control, without
starting a thread or arranging a callback. The host reads
{rust: `control.next_deadline()`}{ocaml: `Timer.Control.next_deadline control`}{ts: `control.nextDeadline()`},
arranges its own wakeup, and calls
{rust: `control.fire_due()`}{ocaml: `Timer.Control.fire_due control`}{ts: `control.fireDue()`}
on the driver when due. Those calls publish Events through the worker
lane; only draining the Store runs their transitions.

{{code host-driven-timer}}

Recheck the deadline after every root input, since it may have armed an
earlier timer. Use the timer clock's time to compute the host's wait; clocks
with different origins cannot have their deadlines compared directly.
{ts: Deadlines are nanoseconds, and `setTimeout` takes milliseconds, at most
2^31 - 1 (about 24.8 days): a longer delay overflows to 1 ms, so cap the
wait, and on waking early find nothing due and arm the next.}
When the worker lane is full, the due timer and those after it stay pending
in deadline order. Drain some Events before retrying, so an overdue timer
does not make the driver spin.

The simulated timer below uses this same mechanism with a manual clock.
{rust: WebAssembly hosts use `Timer::driven`, since the threaded timer is
unavailable there.}

## A timeout per request

This component asks a supplier for a price. In the same reducer it makes a
request ID, keeps the request in a `Pending` table, and emits two Effects:
one sends the request, the other arms a timer pinned to it. The answer and
the timer each become an Action, and each tries to take the request:

{{code quotes}}

The `stale` count is there for the test below to read. A component usually
ignores a stale input and keeps no count of it.

## Retries

When the timer takes the request and attempts are left, the reducer asks
again: a new request, with a new ID and a timer of its own. The first
attempt's answer may still arrive. Its request is no longer pending, so it
is stale, and it cannot be mistaken for the second attempt's answer, as it
would be if the retry reused the first ID. After the last attempt, the
component gives up.

The delay is the Effect's to choose, so a backoff is a delay that grows
with the attempt number. A failure answer can be retried the same way as a
timeout.
{rust: `examples/downloads.rs` does both: it retries a failure or a timeout once, then gives up, and ignores duplicate answers, late answers, and the timers of requests already answered.}

## Testing a timeout without waiting

A test should not sleep for a timeout to pass. The timer has a simulated
form, {rust: `Timer::simulated(&clock)`}{ocaml: `Timer.simulated clock`}{ts: `Timer.simulated(clock)`},
with the same API, on a manual clock. It returns the timer, for the
Services, and its control, which the test hands to a
[test node](testing.html#one-node) with
{rust: `with_timer`}{ocaml: `Node.with_timer`}{ts: `withTimer`}. A simulated timer's
deadline is the clock's time when it was armed plus the delay, and time
moves only when the test moves the clock.
{rust: `fire_timers`}{ocaml: `Node.fire_timers`}{ts: `fireTimers`} fires the timers the clock
has reached, and their Events are held like any other until the test
delivers them; {rust: `next_deadline`}{ocaml: `Node.next_deadline`}{ts: `nextDeadline`} says
when the next one is due.

The test decides whether the answer or the timer comes first. Here the
supplier answers at once, the node holds the answer, and the timer fires
before the answer is delivered:

{{code quotes-timeout}}

A [scenario](testing.html#several-nodes-on-a-simulated-world) does the same
for several nodes: when nothing is held, it moves the clock to the next
timer deadline and fires the timers that are due.

## Keeping requests: `Pending`

`Pending` holds the requests a component waits on, in its State: for
each, what the reducer needs to handle the answer, and an optional
deadline. The examples on this page keep their requests in it, and so do
the shop's payments, their charges
([one checkout, step by step](index.html#one-checkout-step-by-step)).
{rust: Its methods change it in place.}{ocaml: A table is a value, like the rest of State: each change returns a new one.}{ts: A table is a value, like the rest of State: each change returns a new one.}
Requests are kept in ID order, the order they were made in a Store's run.

- {rust: `insert(request, value)`}{ocaml: `Pending.add request value`}{ts: `add(request, value)`}
  waits on a request, and
  {rust: `insert_until(request, value, deadline)`}{ocaml: `Pending.add ~deadline request value`}{ts: `add(request, value, deadline)`}
  waits on it until a deadline as well.
- {rust: `take(request)`}{ocaml: `Pending.take request`}{ts: `take(request)`} is what the
  answer and a timer pinned to the request call. The first gets the value,
  and the request is no longer waited on; the second gets nothing.
- {rust: `cancel(request)`}{ocaml: `Pending.cancel request`}{ts: `cancel(request)`} stops waiting
  without an answer. The answer, when it comes, is stale.
- {rust: `retain(keep)`}{ocaml: `Pending.retain keep`}{ts: `retain(keep)`} stops waiting on
  every request `keep` rejects, such as every request of a piece of work
  that has ended.
- {rust: `clear()`}{ocaml: `Pending.clear`}{ts: `clear()`} stops waiting on all of them,
  such as when a new request replaces the one in flight: clear, then wait
  on the new one, and the old answer is stale.

{{code pending-stale}}

::: rust
With causet's `serde` feature, `Pending` serializes, as a list of pairs,
with the rest of a State that derives `serde`.
:::

::: ts
`Pending` keeps its requests in a private field, which
`assert.deepStrictEqual` and `JSON.stringify` do not see: two tables
compare with `equals`, and one is saved through `entries()` and
`deadline(request)`.
:::

## Why `take` does not look at the time

`take` does not compare the time a timer fired with the request's deadline.
A threaded timer keeps its own monotonic clock, and the Store's clock can
move apart from it: the Store's clock takes corrections and notices a
device's sleep, which a monotonic clock may not. If `take` refused a timer
that arrived before the deadline by the Store's clock, the timeout would be
dropped, and nothing would ever end the request. So the timer pinned to a
request ends it, whenever it arrives.

The deadlines kept in `Pending` are read only by
{rust: `next_deadline` and `expire`}{ocaml: `Pending.next_deadline` and `Pending.expire`}{ts: `nextDeadline` and `expire`},
for one timer that serves many requests.

## One timer for the earliest deadline

A component that waits on many requests can keep one timer instead of one
each. Each request is kept with its deadline, and the timer is armed for
the earliest, {rust: `next_deadline()`}{ocaml: `Pending.next_deadline`}{ts: `nextDeadline()`}.
When it fires, {rust: `expire(now)`}{ocaml: `Pending.expire now`}{ts: `expire(now)`} takes
every request whose deadline has come by the execution's time, in deadline
order and then request order, and the timer is armed again for what is
left.

The timer is pinned to a request ID of its own, kept in State with the
deadline it is armed for. When a new request's deadline comes before that
one, the component arms a new timer, and the old one, when it fires, finds
a different ID and is stale.

`expire` does compare deadlines with the time, the execution's. If a
threaded timer fires early by the Store's clock, nothing is due yet; the
component arms again for the earliest deadline, which is still there, and
the next timer expires it.

{{code lookups}}

Three lookups wait 300, 100 and 200 ms; one answer arrives in time, and the
other two requests expire in deadline order:

{{code lookups-run}}

A timer per request is the simpler of the two: its Event names the
request it ends. One timer for the earliest deadline keeps a single timer
armed however many requests wait, and keeps every deadline in State, where
an invariant or a test can read it.
