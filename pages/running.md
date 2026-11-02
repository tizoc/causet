---
title: Running an application
summary: Starting a Store in one call, driving it with a loop of your own, Services that answer from other threads, and assembling it by hand.
---

Components describe what an application does; something still has to put
them together and keep them running. The tree must be built once and
checked, given its Services, and fed the answers those Services send, often
from threads of their own. Causet leaves the thread and the loop to the
application: a Store runs on whichever thread calls it, and does nothing
between calls.

This page covers starting a Store, the loop that drives it, how Services
on other threads reach the Store and what happens when they send faster
than it drains, assembling the pieces by hand when an application must
choose them, and what is left when something goes wrong.

## Starting a Store

An application starts a Store in one call, from its root component, its
initial State and its Services:
{rust: `Store::start::<Root>(state, services, options)`, where `StoreOptions` holds the clock, `SystemClock` by default}{ocaml: `Store.start ?clock root ~state ~services`, or `Store.start_exn`, where the clock defaults to the system's}{ts: `Store.start(root, { state, services, clock })`, or `Store.startOrThrow`, where the clock defaults to the system's}.
It mounts the root component at `/`, and that registers the whole tree:
each component's `register` declares its slots and the Events it adapts,
and each child bound there registers its own. It checks the tree (below),
makes the Store's Event bus, and returns the Store with the bus's sending
side, the {rust: `EventSink`}{ocaml: sink}{ts: `Sink`}, which {rust: other threads}{ocaml: other threads}{ts: other code} keep to send Events
in. Its worker lane holds
{rust: `hosting::DEFAULT_WORKER_CAPACITY`}{ocaml: `Event_bus.default_worker_capacity`}{ts: `DEFAULT_WORKER_CAPACITY`}
Events, 1024 (below), and its session is fresh. If the tree has problems,
{rust: `start` returns them, a `RegistrationError`}{ocaml: `Store.start` returns `Error problems`, and `Store.start_exn` raises with them}{ts: `Store.start` returns `{ ok: false, problems }`, and `Store.startOrThrow` throws with them}.
{rust: `store.mount(&path)`}{ocaml: `Store.mount store path`}{ts: `store.mount(path)`} resolves a path into the
mount that dispatches and sends address, or says why it cannot{ts:  (`store.mountOrThrow` throws instead)}, and
{rust: `store.protocol()`}{ocaml: `Store.protocol store`}{ts: `store.protocol`} returns the Protocol the Store runs.

{{code start}}


### What freeze checks

Mistakes in wiring are found when the tree is frozen, which starting a
Store does, not when a message first takes the wrong path. Freezing reports every problem it
finds, not only the first: {rust: `freeze` returns a `RegistrationError`, which holds the list of `Problem`s}{ocaml: `Registry.freeze` returns `Error` with the list of problems, and `problem_message` describes each}{ts: `freeze` returns `{ ok: false, problems }`, `problemMessage` describes each, and `freezeOrThrow` throws with all of them}.
It refuses:

- a slot bound twice: two slots of one parent with the same name;
- a child that reports Outputs, on a slot with no lowerer;
- a component with Effects that no Service projection reaches: every mount
  between it and the root must project the Service on;
- an Event registered twice on one mount;
- two mount paths whose instance IDs collide (rename a slot);
- a root registered twice, no root, or a root that reports Outputs;
- a root guard whose path names no mount or another component, one on the
  root itself, or a second one on a mount
  ([scheduling](scheduling.html#admission)).

::: rust

It also refuses a slot declared with `r.child(…)` and never bound with
`.bind()`.

:::

{{code registration-problems}}

### One Services value, split by lenses

The Store holds one Services value, the root's. Each Effect handler sees
only its own part of it, projected from its parent's by the slot's Service
{rust: lens}{ocaml: projection}{ts: projection}. The shop's root binds payments with
{rust: `.service(lens!(ShopServices => gateway))`}{ocaml: `~service:(fun svc -> svc.gateway)`}{ts: `service: (svc) => svc.gateway`},
so the payments handler sees the gateway and nothing else. Mounts that
share a Service project the same part, or the whole value with
{rust: `Lens::identity()`}{ocaml: `Fun.id`}{ts: `(svc) => svc`}.

A component without Effects has no handler and needs no Service of its
own. {rust: `no_effects!()` sets its Effect to `Never` and its Service to `()`. A composite whose children have Effects writes `no_effects!(T)` instead, so that its Service is `T` and its children's lenses can reach into it: the shop's root is `no_effects!(ShopServices)`.}{ocaml: It passes `~effects:Message.never` and no `~handle`. Its Service type is still whatever its children's projections read from: the shop's root's is `shop_services`.}{ts: It leaves out `effects` and `handle`. Its Service type, the second type argument of `component<S, Svc>()`, is still whatever its children's projections read from: the shop's root's is `ShopServices`.}

## Driving the Store

A Store does work only when it is called.
{rust: `dispatch_to`}{ocaml: `Store.dispatch_to`}{ts: `store.dispatchTo`} runs an Action with
everything it causes; {rust: `drain_events(max)`}{ocaml: `Store.drain_events store max`}{ts: `store.drainEvents(max)`}
delivers up to `max` Events waiting on the bus and returns how many it
delivered. Draining never blocks: when nothing waits, it returns 0 at
once. The application owns the loop and can wait for Event readiness
alongside its other inputs and deadlines. Each turn it typically:

- takes in outside input (requests it received, dispatched as Actions; a
  {rust: thread}{ocaml: thread}{ts: callback} that receives input can instead send it as Events through the
  {rust: `EventSink`}{ocaml: sink}{ts: `Sink`});
- drains a bounded batch of Events, so the turn ends even while Events
  keep arriving;
- checks whether it is done: a shutdown request, or, for a batch job,
  nothing left pending;
- waits for readiness, another input or a deadline when nothing was
  delivered, so it does not spin.

This loop runs the shop assembled by hand (as at the end of this page) with
a worker lane of two Events, so the waiting below shows:
{rust: `open(gateway, 2)`}{ocaml: `open_with ~worker_capacity:2`}{ts: `open(gateway, 2)`}.
The gateway answers every charge {rust: from a thread of its own}{ocaml: from a thread of its own}{ts: when a promise settles, outside the Store's run}, and the
loop drains until every charge is settled.
{rust: The dedicated driver waits on the bus between bounded drains.}
{ocaml: The dedicated driver waits on the bus between bounded drains.}
{ts: The host schedules bounded, synchronous turns with `setImmediate`;
the notification only requests a turn.}

{{code driver-loop}}

The example has a deadline because a Service that never answers should
fail a test, rather than leave it waiting forever.

The rest of this section is what the loop waits on, and the other ways to
wait.

### Waiting for Events

{rust: `inbox.readiness()`}{ocaml: `Inbox.readiness inbox`}{ts: `inbox.readiness()`}
returns a readiness handle before the Store takes the inbox;
{rust: `store.readiness()`}{ocaml: `Store.readiness store`}{ts: `store.readiness()`}
returns one afterwards. It belongs to that bus, so the host can keep it
separately from the Store. Its
{rust: `current()`}{ocaml: `Readiness.current`}{ts: `current()`}
reports deliverable Events, closure, or an open, empty bus. Waiting never
consumes an Event or runs a reducer. Held Events become ready only when
released, and closing or faulting the Store signals its driver too.

Each bus has one registration, held by
{rust: a persistent driver notification}{ocaml: a persistent driver notification or by a blocking waiter (below)}{ts: a persistent driver notification}.
{rust: `ready.subscribe(notify)`}{ocaml: `Readiness.subscribe ready notify`}{ts: `ready.subscribe(notify)`}
installs the notification. While the registration is held, registering
again returns
{rust: `ReadinessInUse`}{ocaml: `Already_subscribed`}{ts: `alreadySubscribed`}.
Registration checks readiness too, so already-queued input is signalled
immediately. The same registration signals later batches and closure;
a closed bus signals immediately and retains no callback.

Notifications run outside the queue lock, on the notifying
{rust: thread}{ocaml: thread}{ts: JavaScript turn}. They only signal the
host's driver, which runs the Store later. They must not run the Store
inline.
{rust: Unwinding panics in notifications are ignored; an aborting panic still traps.}
{ocaml: Exceptions from notifications are ignored.}
{ts: Exceptions from notifications are ignored.}
Cancel the subscription with
{rust: `subscription.cancel()`, or drop it}{ocaml: `Readiness.cancel subscription`}{ts: `subscription.cancel()`}
to release the callback. An already-issued notification may still run.

Bursts may coalesce: a notification says the bus became ready, not how many
Events it holds. After each bounded drain, keep scheduling turns while
readiness reports Events. A partially drained queue stays ready and does
not need another notification. Only the host decides when to call the
Store. No executor or async syntax is required.

{{code event-readiness}}

Readiness is a level check, not a reservation: it stays ready until the
Events are drained, and the driver rechecks after waking. Keep one driver
in charge of the Store and drain bounded batches before resting.
{rust: A Store with `Send` State and Services can be moved to a driver
thread; mutable access is still exclusive.}
{ocaml: A Store may be handed to another thread between calls, but callers
must serialize access.}

{rust: On a dedicated native thread, `ready.wait_timeout(duration)` blocks
until Events, closure or the timeout (`None`). It shares the queue lock
with the predicate check, tolerates spurious wakeups within the same
timeout, and holds no registration, so a notification can still be
installed beside it. WebAssembly and UI event loops use notifications.}
{ocaml: On a dedicated native thread, `Readiness.Blocking.create ready`
returns a `(waiter, error) result`. The waiter is reusable and takes the
bus's one registration: creating it returns `Error Already_subscribed`
while a `Readiness.subscribe` notification is active, and
`Readiness.subscribe` returns that error while the waiter is open.
`Readiness.Blocking.wait_timeout waiter ~timeout` blocks until Events,
closure or the timeout in seconds (`None`). Close it with
`Readiness.Blocking.close` on the driver thread when done, which releases
the registration. It reuses its socket pair across waits, with no polling.
Waiting and closing belong to that one driver. Native socket wakeups work
on Unix and Windows without a descriptor-number limit.}

{{code blocking-readiness only=rust,ocaml}}

## Services on other threads

An Effect handler makes a {rust: `Reply<Ev>`}{ocaml: reply}{ts: `Reply<Ev>`} and gives it
to its Service, which may keep it, {rust: move it to a worker thread,}{ocaml: move it to a worker thread,}{ts: hand it to a promise or a callback,} and send the
answer through it later, as {rust: `OnThreads`}{ocaml: `on_threads`}{ts: `later`} does above. The bus has two lanes:

- the **Store lane**, for sends {rust: from the Store's own thread (the one that
  last called `dispatch_to` or `drain_events`)}{ocaml: from the Store's own thread (the one that
  last called `dispatch_to` or `drain_events`)}{ts: made while the Store runs an execution, inside
  `dispatchTo` or `drainEvents`}: in practice, Effect handlers and Services that answer at once. It is
  unbounded: such a send never waits and never fails for room;
- the **worker lane**, for sends {rust: from every other thread}{ocaml: from every other thread}{ts: made at any other time (a promise's continuation, a
  timer or I/O callback, a message relayed from a worker thread)}, bounded by the
  bus's worker capacity.

A drain takes the Store lane first, then the worker lane, each in the order
sent, except what {rust: `send_front`}{ocaml: `send_front`}{ts: `sendFront`} puts ahead (below). {rust: The bus learns which
thread is the Store's at the Store's first call: until then, every send
goes to the worker lane.}{ocaml: The bus learns which
thread is the Store's at the Store's first call: until then, every send
goes to the worker lane.}{ts: Before the Store's first call, as between
calls, every send goes to the worker lane.}
{rust: `try_send_as_worker` and `try_send_to_as_worker`}{ocaml: `Reply.try_send_as_worker` and `Sink.try_send_to_as_worker`}{ts: `reply.trySendAsWorker` and `sink.trySendToAsWorker`}
use the worker lane {rust: from any thread}{ocaml: from any thread}{ts: even during an execution}, for a simulated Service that stands
in for {rust: a thread}{ocaml: a thread}{ts: asynchronous work} ([testing](testing.html)).

::: ts

A `Reply` is a capability, not data: structured clone keeps none of its
methods, so it cannot be posted to a `worker_thread` or a Web Worker. A
Service whose work runs on a worker thread keeps the reply on the main
thread and answers through it when the worker's message arrives there; that
send is outside the Store's run, so it takes the worker lane.

:::

### When the worker lane is full

The capacity is the backpressure: a worker that cannot send holds its
answer, instead of queueing without bound while the Store falls behind.

- {rust: `try_send` and `try_send_to`}{ocaml: `Reply.try_send` and `Sink.try_send_to`}{ts: `reply.trySend` and `sink.trySendTo`}
  never wait. On a full lane they fail with {rust: `Full`}{ocaml: `Full`}{ts: `full`}, and hand the Event
  back: retry later, drop it, or report it.
- {rust: `send_timeout` and `send_timeout_to`}{ocaml: `Reply.send_timeout` and `Sink.send_timeout_to`}{ts: `reply.sendTimeout` and `sink.sendTimeoutTo`}
  wait up to a timeout{rust: , a `Duration`,}{ocaml: , in seconds,}{ts: , in milliseconds,} for
  room, {rust: woken as soon as the Store drains one}{ocaml: checking again every 0.2 ms}{ts: returning a promise that settles as soon as a drain makes room},
  then fail with {rust: `Full`}{ocaml: `Full`}{ts: `full`}. {rust: The threads in the driver loop above wait this
  way.}{ocaml: The threads in the driver loop above wait this
  way.}{ts: The gateway in the driver loop above waits this way; senders
  waiting for room are let in oldest first.}

Observers see the pressure: the `bus` callback, at the start of each drain,
gets both lanes' depths and how many sends were refused for room since the
last report.

{{code worker-lane-full}}

### Ahead of the queue

{rust: `Reply::send_front`}{ocaml: `Reply.send_front`}{ts: `reply.sendFront`} puts an answer at
the head of its lane. {rust: On the Store's thread}{ocaml: On the Store's thread}{ts: During an execution} that is the Store lane, ahead
of every Event waiting there: for a Service that answers at once and whose
answer must come before what is already queued. {rust: From any other thread}{ocaml: From any other thread}{ts: At any other time} it
is the head of the worker lane: it still counts against the lane's
capacity, fails with {rust: `Full`}{ocaml: `Full`}{ts: `full`} when the lane is full, and never waits. The
Store drains the Store lane's head, then the Store lane, then the worker
lane's head, then the worker lane, each head newest first.

{{code send-front}}

### Why a send fails

Every failed send hands its Event back:

| {rust: `SendError`}{ocaml: `send_error`}{ts: `SendError`'s `kind`} | When |
| --- | --- |
| {rust: `Full`}{ocaml: `Full`}{ts: `full`} | The worker lane is at capacity. |
| {rust: `Closed`}{ocaml: `Closed`}{ts: `closed`} | The Store is gone, or it faulted. |
| {rust: `ForeignMount`}{ocaml: `Wrong_protocol`}{ts: `wrongProtocol`} | The mount belongs to another Protocol than the bus. |
| {rust: `Unregistered`}{ocaml: `Unregistered`}{ts: `unregistered`} | The mount's component never registered this Event type. |

The last two concern sends to a mount through the
{rust: `EventSink`}{ocaml: sink}{ts: `Sink`}; a reply's route was made by the Store
for its own mount, so a reply fails only with {rust: `Full` or `Closed`}{ocaml: `Full` or `Closed`}{ts: `full` or `closed`}.
{rust: The compiler already checks that the component adapts the Event (`C: Adapts<Ev>`); `Unregistered` catches one that implements `Adapts` but never called `r.event`.}{ts: A send returns `{ ok: true }` or `{ ok: false, error }`, whose `error.event` is the Event handed back. The types do not check that the component adapts the Event: `unregistered` is how a send learns it.}

### Shutting down

::: rust

Dropping the Store closes its bus: Events still queued are discarded,
every later send fails with `Closed`, on every thread, and senders waiting
for room wake with `Closed`. The bus closes before the State and Services
drop, so a Service that joins its worker threads as it drops finds their
sends already failing, rather than waiting for room. Dropping an inbox that
no Store took closes its bus too, and so does a fault.

:::

::: ocaml

`Store.close` closes the Store's bus: Events still queued are discarded,
every later send fails with `Closed`, on every thread, and senders waiting
for room give up with `Closed`. Only that and a fault close it, so an
application closes its Store when it is done with it.

:::

::: ts

`store.close()` closes the Store's bus: Events still queued are discarded,
every later send fails with `closed`, and a `sendTimeout` waiting for room
settles with `closed` at once. The readiness notification signals the driver,
which observes `closed` and stops its own loop. Only that and a fault close
it, so an application closes its Store when it is done with it.

:::

{{code shutdown}}

## Assembling by hand

An application assembles the pieces itself when it must choose them: a
Registry of its own for root guards
([scheduling](scheduling.html#admission)), one Protocol for several Stores
(the nodes of a simulation), a chosen session or worker capacity, or a held
bus for tests ([testing](testing.html)). It takes the four steps that
starting a Store takes:

1. A **Registry**, typed by the root's State and Services:
   {rust: `Registry::<S, Svc>::new()`}{ocaml: `Registry.create ()`}{ts: `new Registry<S, Svc>()`}.
   Its `root` mounts the root component, which registers the whole tree
   (above).
2. **Freeze** it into a Protocol: the mounted tree, checked, and from then
   on immutable. Every Store of the application (in production, in tests,
   in a simulation of several nodes) runs from one Protocol, and mounts are
   resolved against it. Each freeze makes a Protocol of its own, even of
   the same tree.
3. An **Event bus** for one Store:
   {rust: `EventBus::new(&protocol, worker_capacity)`}{ocaml: `Event_bus.create proto ~worker_capacity`}{ts: `eventBus(protocol, { workerCapacity })`}
   returns its sending side, the {rust: `EventSink`}{ocaml: sink}{ts: `Sink`}, which
   Services and {rust: other threads}{ocaml: other threads}{ts: other code} keep, and its inbox, which the Store takes.
   {ocaml: `Store.sink` returns the sink from the Store too.}{ts: `store.sink` returns the sink from the Store too.} The capacity
   bounds the worker lane (above). Each bus starts a fresh
   session; {rust: `EventBus::with_session`}{ocaml: `Event_bus.with_session`}{ts: the bus's `session` option}
   chooses it ([determinism](determinism.html)).
4. A **Store**, from the Protocol, the initial State, the Services and the
   inbox:
   {rust: `Store::new(protocol, state, services, inbox, options)`, where `StoreOptions` holds the clock, `SystemClock` by default}{ocaml: `Store.create ?clock proto ~state ~services inbox`, where the clock defaults to the system's}{ts: `Store.create(protocol, { state, services, inbox, clock })`, which returns the Store or why it refused the inbox (`Store.createOrThrow` throws instead), and where the clock defaults to the system's}.

{{code assemble}}

{rust: `Store::open(&protocol, state, services, options)`}{ocaml: `Store.open_protocol ?clock protocol ~state ~services`}{ts: `Store.open(protocol, { state, services, clock })`}
does the last two for a Protocol frozen by hand, with a bus of its own as
`start` makes it.

## When something goes wrong

Assembling can fail in two places besides freezing.
{rust: `Store::new`}{ocaml: `Store.create`}{ts: `Store.create`} refuses an inbox from a bus
made for another Protocol ({rust: `ForeignBus`}{ocaml: `Foreign_bus`}{ts: `foreignBus`}), and
closes that bus. {ocaml: Giving one inbox to a second Store raises `Invalid_argument`.}{ts: Giving one inbox to a second Store throws.}
Later, a dispatch to a mount resolved against another Protocol returns
{rust: `ForeignMount`}{ocaml: `Foreign_mount`}{ts: `foreignMount`}, and does nothing.

{{code store-errors}}

A State or Services of another type than the root's does not compile: a
Protocol carries its root's types{rust: (`Protocol<S, Svc>`)}{ocaml: (`('s, 'svc) protocol`)}{ts: (`Protocol<S, Svc>`)}.

{{code wrong-root-types only=rust,ts}}

A {rust: panic}{ocaml: raise}{ts: throw} in application code faults the Store
([scheduling](scheduling.html#faults)): the call that ran it, and every
call after, returns {rust: `DispatchError::Faulted`}{ocaml: `Error (Faulted message)`}{ts: a `faulted` error}
with the message, which {rust: `Store::fault`}{ocaml: `Store.fault`}{ts: `store.fault`} also
returns{ocaml: ; `Store.fault_location` says where it was raised, when backtraces are recorded}{ts: ; `store.faultLocation` says where it was thrown, when the error's stack tells}.
Nothing is rolled back, and the Store runs nothing more. A fault closes the
Store's bus at once, as {rust: dropping}{ocaml: closing}{ts: closing} the Store does:
Events still queued are discarded, and every later send fails with
{rust: `Closed`}{ocaml: `Closed`}{ts: `closed`}, so Services learn the Store is gone and stop. If the application
goes on, it opens a new Store, with a new bus, on the same Protocol:
{rust: `Store::open(store.protocol(), state, services, options)`}{ocaml: `Store.open_protocol (Store.protocol store) ~state ~services`}{ts: `Store.open(store.protocol, { state, services })`}.
The mounts it holds stay valid there; starting from the root component
again would freeze a new Protocol, whose Stores refuse them.
