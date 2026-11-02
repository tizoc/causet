---
title: Testing
summary: Find bugs with generated simulations, shrink failures and reproduce them; then test individual transitions, several nodes and invariants with memory.
---

**Find bugs automatically:** define the operations a test may perform and
the invariants that must hold. Causet generates seeded runs, finds
violations, shrinks a failure and gives you its replay choices. The
[overview's payment example](index.html#find-bugs-automatically) shows the
whole process, including checking the fix.

Asynchronous bugs hide in orderings: an answer that arrives after its
timeout, two answers swapped, a node that restarts in the middle of a
request. Tests that sleep and hope rarely find them. A causet test runs the
real application but holds everything the outside world would do, so it
chooses the order itself: deliver this answer, drop that one, move the
clock. It can then generate thousands of such choices and shrink a failure
to a few steps you can replay.

This page builds up in layers: one transition, one node driven by hand,
generated runs with invariants, and several nodes on a simulated network.
Most tests need nothing more. The sections after them are for larger ones:
invariants that compare with earlier steps, choosing the order of delivery
across nodes, and fixtures that start in the middle of a workflow.
Projections have checks of their own, on the
[projections](projections.html) page.

From one node on, tests run the real Store. {rust: The `causet-test` crate (a dev-dependency; its own documentation is `cargo doc -p causet-test`)}{ocaml: `Causet_test`}{ts: `causet/test`}
wraps it so that nothing happens until the test says so: every Event a
Service sends is held, time is a shared virtual clock, and the
application's invariants are checked after every root input. A run is then
a list of choices, which can be generated, shrunk when it fails, and
repeated, as long as every Service in it is simulated or otherwise
controlled by the test: holding Events and a manual clock do not reach a
real Service's threads, I/O, clock or randomness. The examples below use
the guide's shop ({rust: `causet::guide::shop`}{ocaml: `Causet_guide.Shop`}{ts: `causet/guide`}).

{{code opens only=ocaml}}

## One transition

The smallest test runs one reducer, with no Store at all: a
{rust: `Harness`}{ocaml: `Causet.Harness`}{ts: `Harness`} dispatches an Action to one component, runs its
enabling check and its reducer at a time the test sets, and returns what
the reducer emitted, in order ([authority](authority.html) shows one). It
is the place for a transition's own rules. The rest of this page runs the
real Store.

## One node

A {rust: `Node`}{ocaml: `Causet_test.Node`}{ts: `Node`} is a Store on a held bus, with
a chosen session and a {rust: `ManualClock`}{ocaml: `Causet.Clock.Manual` clock}{ts: `ManualClock`}.
{rust: `check`}{ocaml: `Node.check`}{ts: `check`} registers an invariant: a read-only
function of State that says what is wrong, if anything. It is checked at
once, which validates the starting State, then after every root input. A
violation {rust: panics}{ocaml: fails the run}{ts: fails the run}, naming the node, the
invariant and the step.

{{code one-node}}

{rust: `deliver_next`}{ocaml: `Node.deliver_next`}{ts: `deliverNext`} takes the held Event the
bus would have run next, so delivering one at a time runs Events in
production's order. {rust: `deliver`, `deliver_where` and `discard`}{ocaml: `Node.deliver`, `Node.deliver_where` and `Node.discard`}{ts: `deliver`, `deliverWhere` and `discard`}
choose otherwise: an answer that comes late, out of order, or never. A held
Event is delivered once; an answer that comes twice is one the simulated
Service sends twice. {rust: `restart`}{ocaml: `Node.restart`}{ts: `restart`} rebuilds the
Store from a given State, Services and session; with a new session, an
answer meant for the run before is told apart.

## Generated runs

{rust: `check(config, f)` calls `f` with an `Rng` and its runs: `Config::default()`}{ocaml: `check f` calls `f` with an `Causet_test.Rng.t` for each of its runs: `default`}{ts: `check(f)`, or `check(config, f)`, calls `f` with an `Rng` for each of its runs: `defaultConfig`}
makes 100, from seed 0, and the environment overrides them with
`CAUSET_RUNS` and `CAUSET_SEED`. Every draw is a bounded integer, and 0 is
always the simplest answer: {rust: `below(n)`, `between`, `chance`, `pick`, and `more`}{ocaml: `Rng.below`, `Rng.between`, `Rng.chance`, `Rng.pick`, and `Rng.more`}{ts: `below(n)`, `between`, `chance`, `pick`, and `more`},
which says whether the run takes another step, 15 times in 16. A run fails
when it {rust: panics}{ocaml: raises}{ts: throws}, which includes an invariant of any
{rust: `Node`}{ocaml: node}{ts: `Node`}. The failing run's choices are then shrunk to a
small list that fails the same way, and printed with a call that repeats
it, in this form:

::: rust

```text
causet_test::check: the run with seed <seed> failed (<what failed>); shrunk from <n> choices to <m> in <runs> runs. Repeat it with CAUSET_SEED=<seed> or
    causet_test::replay(&[<the shrunk choices>], ...)
```

:::

::: ocaml

```text
causet_test.check: the run with seed <seed> failed (<what failed>); shrunk from <n> choices to <m> in <runs> runs. Repeat it with CAUSET_SEED=<seed> or
    Causet_test.replay [<the shrunk choices>] ...
```

:::

::: ts

```text
causet/test check: the run with seed <seed> failed (<what failed>); shrunk from <n> choices to <m> in <runs> runs. Repeat it with CAUSET_SEED=<seed> or
    replay([<the shrunk choices>], ...)
```

:::

What failed names the check when an invariant failed, such as
`node shop: invariant "..."` or `group shops: invariant "..."`; otherwise
it is where the run failed, such as `panic at <file>:<line>` for a test's
own assertion, or `step budget`. With a {rust: `Config`}{ocaml: `config`}{ts: `Config`}
whose {rust: `max_steps`}{ocaml: `max_steps`}{ts: `maxSteps`} is not the default, the call printed {rust: is `causet_test::replay_with`, with that `Config`}{ocaml: passes that config}{ts: passes that `maxSteps`}.
The shrunk run is then made once more, so its own {rust: panic}{ocaml: exception}{ts: error}
fails the test; if it passes instead, the run was not repeatable, and
`check` says so.

Every run that passes is made a second time from its own choices. The
second must pass too, and run the same executions, refusals and inline
calls on every node, each with the same message, compared by its printed
form; the first that differs fails the test as not deterministic, naming
where the two first differ, and so does a second making that rejects. A
run that reads what its choices do not decide ({rust: the system clock, a
`HashMap`'s order, a thread's timing}{ocaml: the system clock, a
`Hashtbl`'s order, a thread's timing}{ts: the system clock, `Math.random`,
a timer's or a promise's timing}) is caught
the first time it shows, rather than when a shrunk failure will not
replay. {rust: `Config::determinism`}{ocaml: `config.determinism`}{ts: the `Config`'s `determinism`} turns it
off; a run that makes no {rust: `Node`}{ocaml: node}{ts: `Node`} is made once.

The check sees only what the nodes do and send. A difference that stays in
State, never changing a message, a refusal or what runs, passes it; an
invariant on that State is what catches it. A message compares only as
far as it prints: {rust: one whose `Debug` form varies from run to run, such as one holding a `HashMap`, is reported even when nothing else differs, so hold a `BTreeMap` in messages}{ocaml: one with no printer, written by hand without `~pp` or derived with `~no_pp`, prints as `_` and compares by kind alone}{ts: a value prints field by field, but a function in it prints as `_` and a class instance shows its public fields only, never its `#private` ones, so give such a message's descriptor a `debug` printer, or the value a `[debugCustom]` method}.

A {rust: `replay(&choices, f)`}{ocaml: `replay choices f`}{ts: `replay(choices, f)`} with that list is
the failure kept as a regression test. {rust: `rng.reject()`}{ocaml: `Rng.reject`}{ts: `rng.reject()`}
ends a run that drew an invalid fixture, without counting it. `search`
finds and shrinks the first failure as `check` does, and returns it instead
of failing, without the final replay and without reading `CAUSET_RUNS` or
`CAUSET_SEED`: it is how a test shows that a planted bug is found.

Two tools make rare interleavings likelier:

- **{rust: `Rng::split`}{ocaml: `Rng.split`}{ts: `Rng`'s `split`} gives the world its own
  stream.** The world (a simulated network, Services' delays and failures)
  draws from a split generator, and the run's steps from its own. Neither
  then shifts the other's draws, so a change to the steps does not move the
  world. A run's choices are its steps' and one seed, and replaying them
  replays the world.
- **`Swarm` varies the mix of steps between runs.** It draws, once per run,
  which step kinds the run uses (each on with chance 1/2; all, if none is),
  then {rust: `pick`}{ocaml: `Swarm.pick`}{ts: `pick`} chooses among them by weight.
  One run sends often and never restarts; another does little but restart.
  A bug that needs one kind often and another rarely is found in fewer runs
  than with one mix for every run.

## Several nodes on a simulated world

{rust: `examples/wallet-send` and `examples/p2p-node`}{ocaml: `examples/wallet_send` and `examples/p2p_node`}{ts: `examples/wallet-send` and `examples/p2p-node`}
test several Stores this way:

1. **One shared world.** The network or the remote service
   {rust: lives in one value behind `Arc<Mutex<_>>`. The nodes' Services hold clones of it, and so does the test, as a `World`.}{ocaml: is one value, which the nodes' Services and the test's `Causet_test.world` share.}{ts: is one object, which the nodes' Services hold and the test drives as its `World`.}
   A Service does not answer: it puts the answer in flight. An
   {rust: `InFlight`}{ocaml: `Causet_test.In_flight`}{ts: `InFlight`} holds the world's
   messages, due in order of time and, when due together, of sending; on a
   channel (one direction of a link),
   {rust: `send_in_order`}{ocaml: `In_flight.send_in_order`}{ts: `sendInOrder`} keeps a
   message after the one before it, whatever delay it drew.
   {rust: `World::next_time`}{ocaml: The world's `next_time`}{ts: The world's `nextTime`} reports when
   the next one is due, and `advance` delivers what
   {rust: `due(now)`}{ocaml: `In_flight.due`}{ts: `due(now)`} returns, through a node's
   {rust: `sink` or the `Reply`}{ocaml: sink or the reply}{ts: `sink` or the `Reply`} it was sent
   with. What stands in for a worker thread sends with
   {rust: `try_send_to_as_worker` or `Reply::try_send_as_worker`}{ocaml: `Sink.try_send_to_as_worker` or `Reply.try_send_as_worker`}{ts: `trySendToAsWorker` or `Reply`'s `trySendAsWorker`},
   so its Events take the worker lane, as they would in production.
2. **One clock and one scenario.** A
   {rust: `Scenario`}{ocaml: `Causet_test.Scenario`}{ts: `Scenario`} drives every node on
   one virtual clock. {rust: `step`}{ocaml: `Scenario.step`}{ts: `step`} delivers a
   held Event if any node holds one, and otherwise advances the clock to
   the next timer deadline or world time, lets the world act, then fires
   the timers. {rust: `run_until`}{ocaml: `Scenario.run_until`}{ts: `runUntil`} steps until
   a predicate holds, nothing is left
   ({rust: `Stop::Quiet`}{ocaml: `Quiet`}{ts: `"quiet"`}), a step budget runs out or a
   time limit is reached. {rust: A scenario dropped by a failing test prints its last steps, and its seed when it draws from one; under `check`, that is the shrunk run's replay, which draws from its choices.}
   Timers are {rust: `Timer::simulated`}{ocaml: `Timer.simulated`}{ts: `Timer.simulated`} on the
   scenario's clock, handed to the node with
   {rust: `with_timer`}{ocaml: `Node.with_timer`}{ts: `withTimer`}.
3. **Invariants per node and over the group.** Each node checks its own
   State. A {rust: `Group`}{ocaml: `Causet_test.Group`}{ts: `Group`} holds what spans
   the nodes: each node publishes a view of its State
   ({rust: `publish`}{ocaml: `Node.publish`}{ts: `publish`}), and the group's checks read
   every view after any member's root input.
4. **Generated steps, then the end.** The world draws from
   {rust: `rng.split()`}{ocaml: `Rng.split rng`}{ts: `rng.split()`}, the steps from a `Swarm`
   while {rust: `rng.more()`}{ocaml: `Rng.more rng`}{ts: `rng.more()`}. Then the scenario
   runs until it is quiet, and the test checks what must hold once nothing
   is left: every request ended, nothing left pending.

A shop's gateway, shared here by up to three shops, approves charges while
a budget lasts and answers 1 to 50 ms later. The shops cannot see one
another; the group checks that together they were never paid more than the
budget. A bank that forgets what it approved is found, and shrunk:

{{code shared-world}}

The two larger examples go further. Both worlds delay what is in flight, and break
links, losing what was on them. {rust: wallet-send's}{ocaml: wallet_send's}{ts: wallet-send's}
peers also restart and lie. {rust: p2p-node's}{ocaml: p2p_node's}{ts: p2p-node's} world
also delivers stale callbacks again and opens extra links; and it adds an
observer on each Store that checks why things happen (an answer only to the
request that was sent, a disconnection reported once).
{rust: `examples/chain-placement`}{ocaml: `examples/chain_placement`}{ts: `examples/chain-placement`} has
no Store: its generated runs make logs for a projection, and check them as
the [projections](projections.html#checking-restarts) page does.

::: rust

`examples/p2p` has only doctests that some code does not compile; p2p-node
runs it.

:::

## Invariants that remember

Some properties are about change rather than about one State: a payment is
never forgotten, a count only grows, a value changes only when a certain
Event arrives. {rust: `check_with`}{ocaml: `Node.check_with`}{ts: `checkWith`} registers
such an invariant. Its checker is called with the State and with the step
it runs at, and what it captures is its memory, so it can compare the
State with the one it saw last. The step is one of three:

- {rust: `InvariantStep::Added`}{ocaml: `Added`}{ts: `{ step: "added" }`}: the invariant was just
  registered, on the State as it is.
- {rust: `InvariantStep::Settled`}{ocaml: `Settled_step`}{ts: `{ step: "settled", … }`}: a root input ran
  with everything it caused, an admitted Action or one drained Event. It
  carries that input's execution, category, path, kind and time. There is
  no step after a refused Action, an empty drain or a fault.
- {rust: `InvariantStep::Restored`}{ocaml: `Restored`}{ts: `{ step: "restored" }`}: the node restarted.
  {rust: `restart`}{ocaml: `Node.restart`}{ts: `restart`} moves the invariants, with their
  memory, into the new Store and runs them on the restored State before any
  root input, so an invariant can compare what the run kept with what it
  had.

{rust: `check`}{ocaml: `Node.check`}{ts: `check`} is {rust: `check_with`}{ocaml: `check_with`}{ts: `checkWith`} with a checker that
ignores the step. A checker that {rust: panics}{ocaml: raises}{ts: throws} fails the
node under the key `node <name>: invariant "<name>" panicked`, and the
Store disables it, since its memory may be half updated.

Here the invariant remembers what was paid. The amount may grow only when
a `payments.charged` Event settles, and may not change on any other root
input or on a restart. A restart that keeps the State passes; one that
starts again from an empty State is found:

{{code check-with}}

A group's checks have the same two inputs. A
{rust: `Group::check`}{ocaml: `Group.check`}{ts: a group's `check`} is called with the members'
views and the step it runs at, and its captures are its memory:

- {rust: `GroupStep::Added`}{ocaml: `Added`}{ts: `{ step: "added" }`}: the check was just added, on
  the views as they are.
- {rust: `GroupStep::Published { node }`}{ocaml: `Published node`}{ts: `{ step: "published", node }`}: `node`
  joined with its first view.
- {rust: `GroupStep::Settled { node }`}{ocaml: `Settled node`}{ts: `{ step: "settled", node }`}: a root
  input of `node` settled, and its views were refreshed.
- {rust: `GroupStep::Restarted { node }`}{ocaml: `Restarted node`}{ts: `{ step: "restarted", node }`}: `node`
  restarted, and its view is the restored State's.

A node leaves its groups {rust: when it is dropped}{ocaml: with `Node.close`, which also closes its Store, or by name with `Group.leave`}{ts: with `close`, which also closes its Store, or by name with the group's `leave`},
and no check runs then: its view is simply gone from the next step's
views. A check that must still count what a departed node did keeps it in
its memory. Here each shop's paid total is remembered after the shop has
gone, so the budget still counts shop a's 4 once a has gone. With shop b
paid 5 the two make 9, within the budget of 10; with 7 they make 11, which
the check finds although shop b's view alone is within it:

{{code group-steps}}

## Choosing the order across nodes

{rust: `Scenario::step`}{ocaml: `Scenario.step`}{ts: A scenario's `step`} delivers, of the first
node that holds something, the Event its bus would run next. Across nodes
that is a fixed order: the first node's Events always go first.
{rust: `step_with`}{ocaml: `Scenario.step_with`}{ts: `stepWith`} takes a
{rust: `Chooser`}{ocaml: `~choose` function}{ts: `Chooser`} instead, which picks the Event
to deliver. It is given every node's held Events, as
{rust: `(node, HeldEvent)`}{ocaml: `(node, held_event)`}{ts: `{ node, event }`} pairs listed node by
node, each node's in send order, with the scenario's generator, and returns
an index into them. A scenario made {rust: with `Scenario::with_rng`}{ocaml: with `Scenario.with_rng`}{ts: with `Scenario.withRng`}
from a generated run's generator draws from the run's choices, so an order
found this way is shrunk and replayed with the rest of the run. A step that
finds nothing held advances the clock as `step` does.

Here three answers are held on two shops. The chooser picks any of them,
and with seed 1 the second shop's answer goes first, then the first shop's
answers in the opposite order to the one they were sent in:

{{code choose-order}}

A chooser that varies the order across nodes but keeps production's order
within each one uses {rust: `next_in_queue_order`}{ocaml: `next_in_queue_order`}{ts: `nextInQueueOrder`}. Given one node's held Events in
send order, it returns the one its lanes would run had none been held: the
Store lane before the worker lane, and on each lane the Events sent to its
head newest first, then the others oldest first.
{rust: `step` and `Node::deliver_next`}{ocaml: `Scenario.step` and `Node.deliver_next`}{ts: `step` and `deliverNext`} use it.

{{code queue-order}}

A scenario also says what it did. Its log has a line for every step taken,
such as `shop 1: deliver payments.charged to /payments` or
`advance to <time>: <n> timers fired`, oldest first; a test adds its own
{rust: by pushing onto the public `log`}{ocaml: with `Scenario.note`}{ts: with `note`}.
{rust: `report(last)`}{ocaml: `Scenario.report`}{ts: `report(last)`} is the failure report:
the seed (or that the choices were replayed), the number of steps and the
last `last` of them. {rust: It is what a scenario prints, with the last 20 steps, when it is dropped by a failing test.}
{rust: `pending`}{ocaml: `Scenario.pending`}{ts: `pending`} says what is left, for a run
that stopped without reaching its condition: the clock, each node's held
Events (with the lane each waits for and the Effect it answers) and its
next timer, and the world's next time.
{rust: `into_log` takes the log out of a finished scenario, since a field cannot be moved out of a value that reports on drop.}{ocaml: `Scenario.log` returns the log.}{ts: `log` is the log.}

## Fixtures that start mid-workflow

A test of what happens late in a workflow does not have to run the
workflow first. A node starts from any State, and its invariants are
checked on that State at once, so a fixture that breaks them fails before
the first step. What the State refers to outside the Store (a charge the
gateway has taken, an answer on its way) is made by the test in the same
way:

- {rust: `EventSink::reply_for`}{ocaml: `Sink.reply_for`}{ts: `Sink`'s `replyFor`} makes the reply
  route an Effect would have made: to a mount, answering a given execution.
  A simulated Service holds it and answers through it like any reply.
  It is {rust: `None` for a mount of another Protocol or an Event type the mount does not register}{ocaml: `None` when the mount does not adapt the Event type}{ts: `undefined` for a mount of another Protocol or one that does not adapt the Event type}.
- The answer is held like any Event.
  {rust: `held`}{ocaml: `Node.held`}{ts: `held`} lists what is held, in send order:
  each with its id, its mount's path, its Event type and kind, the
  execution it answers, its session and its lane.
  {rust: `inspect`}{ocaml: `Node.inspect`}{ts: `inspect`} reads one held Event's value
  without delivering it, {rust: `deliver`}{ocaml: `Node.deliver`}{ts: `deliver`} delivers
  it, and {rust: `discard`}{ocaml: `Node.discard`}{ts: `discard`} drops it as a lost
  message.
- {rust: `fire_timers`}{ocaml: `Node.fire_timers`}{ts: `fireTimers`} fires the node's
  simulated timers (given with {rust: `with_timer`}{ocaml: `Node.with_timer`}{ts: `withTimer`})
  that are due on the shared clock, and holds their Events like any other;
  {rust: `next_deadline`}{ocaml: `Node.next_deadline`}{ts: `nextDeadline`} is the earliest
  deadline. The [timeouts page](timeouts.html) covers timers.
- {rust: `try_mount` returns the mount at a path or why there is none, where `mount` panics; `store` and `store_mut` give the Store itself, to add observers and the like.}{ocaml: `Node.mount` raises when a path has no mount; `Protocol.resolve` on `Node.protocol` returns why. `Node.store` gives the Store itself, to add observers and the like, and `Node.close` closes it and leaves the node's groups.}{ts: `tryMount` returns the mount at a path or why there is none, where `mount` throws; `store` gives the Store itself, to add observers and the like, and `close` closes it and leaves the node's groups.}

Here a shop starts as if a checkout of 30 had run: its Effect, execution 7,
made the request, which is pending, and the charge is with a gateway that
does not answer by itself. The test answers twice, as the gateway's worker
would, loses the second answer and delivers the first:

{{code mid-workflow}}

Under every node is a held bus,
{rust: `EventBus::held(protocol, worker_capacity, session)`}{ocaml: `Event_bus.held proto ~worker_capacity session`}{ts: `heldBus(protocol, { workerCapacity, session })`},
which a test can use with a Store directly. Every accepted send waits in a
held set, never waiting or failing for room, until the test's handle
({rust: `HeldEvents`}{ocaml: `Held.t`}{ts: `Held`}) releases it into its lane or
discards it. The handle lists, inspects, releases and discards; it never
delivers anything itself: the Store's {rust: `drain_events`}{ocaml: `drain_events`}{ts: `drainEvents`} does, by the ordinary
rules. A release into a full worker lane is refused, and the Event stays
held.

{{code held-bus}}
