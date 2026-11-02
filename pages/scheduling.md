---
title: Scheduling
summary: The order in which work runs, admission, and faults.
---

When a reducer emits several things, or an answer arrives while other work
is queued, what runs first? In threaded code it depends on timing. In
causet a few rules fix it, the same in every run, and this page states
them. They are what you need to read a trace, to know what State a reducer
will see, and to understand why a run repeats exactly.

In short: the Store takes one input at a time, and everything that input
causes runs before the next. Inside, work runs in the order it was
emitted, and an Action's consequences run before whatever was emitted
after it. Every Action is checked just before it runs, against the State
of that moment; a refused one is skipped, not an error.
{rust: A panic}{ocaml: An exception}{ts: An exception} stops the Store.

The sections below give the details: root inputs, the order within one,
admission, time, the observer callbacks, Events, faults, and bug reports.

{{code opens only=ocaml}}

## Root inputs

Work enters a Store in two ways, each a *root input*:

- an Action dispatched by the application:
  {rust: `Store::dispatch_to`}{ocaml: `Store.dispatch_to`}{ts: `store.dispatchTo`};
- an Event taken from the bus by
  {rust: `Store::drain_events`}{ocaml: `Store.drain_events`}{ts: `store.drainEvents`}.

A root input runs to completion, everything it causes included, before the
call returns. There is no implicit yielding and no asynchronous reducer.
{ts: A reducer, an Effect handler, an Event adapter, an Output lowerer or an observer that returns a promise faults the Store.}

## One FIFO per execution, drained depth first

A reducer appends what it emits to its own private FIFO, in exactly the
order it emits, never grouped by category. When the reducer returns, the
Store drains that FIFO from the front:

1. A queued Action is checked for admission against the State and time of
   that moment. If admitted, it runs, with everything it causes, before the
   next item.
2. A refused Action is skipped. It gets no execution ID and no ordinal;
   observers are told of it once ({rust: `action_refused`}{ocaml: `action_refused`}{ts: `actionRefused`}), and later items still
   run.
3. An Effect runs its handler at its exact position.
4. An Action an Effect handler dispatches runs at once, with everything it
   causes, before the handler resumes.

So if a reducer emits Action `A`, Effect `B` and Action `C`, what `A` causes
runs before `B`, and `B`'s handler (with what it dispatches) before
`C`{ocaml: . Each message type derives its message with
`[@@deriving message]`, which names each kind after its constructor
(`A_child` is `steps.a_child`)}{ts: . A message is a union tagged by its
kind, so each value names its kind where it is made: `{ kind: "steps.a_child" }`}:

{{code steps-component only=ocaml}}

{{code fifo-order}}

## Admission

An Action runs only if every check admits it, against the same State and
time, in this order:

1. its destination's State is available (a {rust: fallible}{ocaml: optional}{ts: optional}
   lens can make it absent; see [addressing](addressing.html));
2. the root guard on its mount, if the application set one (below);
3. the parent's admission guard for the slot, if the slot has one;
4. the component's own {rust: `is_enabled`}{ocaml: `is_enabled`}{ts: `isEnabled`}, which admits by default.

The first check that refuses is the one observers are told of. The same
checks run on every route: dispatched from outside, queued, sent to a child,
dispatched by an Effect handler, lowered from an Output, adapted from an
Event, or called inline, except that a root guard does not run on an inline
call made below the root. A refusal at the root is not an error:

{{code refused-at-root}}

Queued Actions are checked when they reach the front of the FIFO, never when
emitted, so they see everything that ran before them. Write the enabling
check first: it is where ordering, timeouts and stale input are decided, so
the reducer can assume its Action was admitted.

### Root guards

A component's own check reads its own State, and a slot guard its parent's.
A condition on the rest of the application's State is a **root guard**: the
application sets it on any mount below the root, by its path, as a function
of the whole State, the mount's own State, the Action and the time
({rust: `Registry::admit`}{ocaml: `Registry.admit`}{ts: `registry.admit`}).

{{code root-guard}}

A root guard checks every Action that **enters** its mount: one the Store
admits there to start an execution, dispatched from outside, queued, adapted
from an Event, lowered from an Output or dispatched by an Effect handler. It
reads the State as it is when the Action runs. It also checks the root's own
inline calls, since the root holds the whole State. An inline call made
below the root does not enter the mount: the child runs inside its caller's
execution without the root guard, so the caller takes on what it checks.
Observers are told which inline calls skipped one:
{rust: `InlineCall::root_guard_skipped`}{ocaml: the inline call's `root_guard_skipped`}{ts: the inline call's `rootGuardSkipped`}.

So a parent that forwards an Action to its child with
{rust: `to_child`}{ocaml: `Ctx.to_child`}{ts: `ctx.toChild`} has it checked by the child's root guard as it
enters the child. A parent below the root that forwards it inline, to act on
the result at once, skips the child's root guard: the condition is then
checked where the Action entered, on the parent's own Action, by the
parent's root guard, which sees the wrapping Action. The two guards can
share one function of the whole State.

A {rust: panic}{ocaml: exception}{ts: exception} in a root guard faults the Store, like one anywhere in a
root input; on an inline call it first {rust: unwinds}{ocaml: propagates}{ts: propagates} through
{rust: `reduce_child`}{ocaml: `Ctx.reduce_child`}{ts: `reduceChild`} to the caller, as any {rust: panic}{ocaml: exception}{ts: exception} in an inline
call does.

Freezing the Registry reports a root guard whose path names no mount or
another component, one on the root itself, and a second one on the same
mount. A Store with root guards is opened from that Protocol with
{rust: `Store::open`}{ocaml: `Store.open_protocol`}{ts: `Store.open`}
([assembling by hand](running.html#assembling-by-hand)).

## Time

Every execution reads the Store's {rust: `Clock`}{ocaml: `Causet.Clock`}{ts: `Clock`} as
it starts. Its time is {rust: `max(previous, now)`}{ocaml: `max previous now`}{ts: `Math.max(now, previous)`},
so times never go back, whatever the clock does; executions in the same
instant share it. Its ID is apart from time: the Store numbers executions 1,
2, 3, ... as they start, so IDs order the run exactly. A root Action reads
the clock once, at dispatch, and is admitted at that time; a queued Action is
admitted at the time of the execution before it. Reducers read the time from
their metadata (`meta.time`), never from the system clock (see
[determinism](determinism.html)).

## Lifecycle

Observers ({rust: `Observer`}{ocaml: `Causet.Observe.t`}{ts: `Observer`, whose methods are all optional}) are called at each
boundary:

```text
Action start                          Effect start        Event start
  reducer                               handler             adapter
    inline child: inline action       Effect finish       Event finish
Action finish                                             drain its FIFO
  drain its FIFO                                          Event settled
Action settled
```

*Settled* means everything the Action or Event caused has finished or been
refused.

Two calls fall outside an execution's own boundaries. {rust: `action_refused`}{ocaml: `action_refused`}{ts: `actionRefused`}
tells of an Action refused at admission, wherever it was sent from (a root
dispatch, an Effect handler, a queue, or an inline call), with what refused
it and the execution that sent it. {rust: `inline_action`}{ocaml: `inline_action`}{ts: `inlineAction`} tells of a child's Action
admitted inline ({rust: `reduce_child`}{ocaml: `Ctx.reduce_child`}{ts: `ctx.reduceChild`}), just
before its reducer runs within its parent's execution, at its parent's
time: it has no {rust: `action_start`}{ocaml: `action_start`}{ts: `actionStart`} of its own. Both see the payload, and
neither makes an execution, so they change no ID, ordinal or time. A Store with no observers
skips them, as it skips every callback, and then reads no kind for them.

## Events

{rust: `Store::drain_events`}{ocaml: `Store.drain_events`}{ts: `store.drainEvents`} takes up to a
given number of Events from the bus, each as its own root input: its adapter
runs, and the Actions it emits drain fully before the next Event. Events
sent {rust: from the Store's own thread (by Effect handlers) come before those sent
by worker threads}{ocaml: from the Store's own thread (by Effect handlers) come before those sent
by worker threads}{ts: during an execution (by Effect handlers) come before those sent at any
other time (see [running](running.html))}. Draining is the application's call, typically in its
driver loop:

{{code drain-events}}

## Faults

{rust: A panic}{ocaml: An exception}{ts: An exception} anywhere in a root input's work (an
enabling check, a guard, a reducer, an Effect handler, an adapter, a
lowerer) is caught where the root input entered. It faults the Store: the
call returns {rust: `DispatchError::Faulted`}{ocaml: `Error (Faulted message)`}{ts: `{ ok: false, error: { kind: "faulted", message } }`},
every later call returns it too, observers are told, and nothing is rolled
back. Nothing that was interrupted resumes.

An Effect handler can {rust: catch the panic}{ocaml: catch the exception}{ts: catch the exception}
of an Action it dispatched synchronously, but that does not undo the fault.
The Store faults as the {rust: panic}{ocaml: exception}{ts: exception} leaves the
dispatch: the fault is the first one, with its own message and place, the
bus closes, and observers are told once. The handler finds the Store
faulted: a later dispatch runs nothing and returns
{rust: `DispatchOutcome::Faulted`}{ocaml: `Faulted`}{ts: `"faulted"`}, and as the handler
returns, the rest of the root input is dropped. The call that started the
root input returns the fault.

{{code fragile-component only=ocaml}}

{{code fault}}

Expected failures, such as a declined payment or an unreachable peer, are
not faults: Services report them as Events, and reducers handle them like
any other fact. {rust: Built with `panic = "abort"`, a panic cannot be
caught: the process ends.}

## Bug reports

Between an expected failure and a fault sits the bug: a state the code
believes impossible, such as an index naming an item the list does not have.
{rust: Panicking}{ocaml: Raising}{ts: Throwing} would stop a production node for one bug;
ignoring it would hide it. {rust: `bug_condition!`}{ocaml: `Bug.condition`}{ts: `bugCondition`}
reports it and returns, and the caller carries on with a fallback it
chooses, the same in every build:

{{code shelf-component only=ocaml}}

{{code bug-report}}

- **A report has a place:** the phase (admission, reducer, Effect
  handler, adapter, observer), the execution it happened in (for an
  admission, the execution that queued or dispatched the Action), the
  component whose code made it, and its number in the run. Reports reach
  observers ({rust: `Observer::bug`}{ocaml: `bug`}{ts: `bug`}) in the order they
  happened: a handler's report made before it dispatches an Action comes
  before that Action.
- **Nothing is cancelled.** A report does not stop the reducer, roll back
  what it changed, or stop a parent that called the reporting child inline.
  The fallback is the safeguard, so choose it as carefully as the check;
  where you can, check before changing State, so a fallback finds nothing
  half done.
- **Tests check reports after the run** with
  {rust: `BugLog`: `assert_none()` for ordinary tests, `assert_messages(...)`
  for tests of a recovery}{ocaml: `Causet.Observe.Bug_log`; a
  `Causet_test.Node` fails on any report unless told `allow_bugs`}{ts: `BugLog`:
  `assertNone()` for ordinary tests, `assertMessages([...])` for tests of a
  recovery; a `Node` of `causet/test` fails on any report unless told
  `allowBugs()`}. The run
  itself never {rust: panics}{ocaml: raises}{ts: throws} on a report, so tests exercise
  the fallback production takes. A component tested alone keeps its reports
  in its {rust: `Harness`}{ocaml: `Causet.Harness`}{ts: `Harness` (`bugReports`)}.
- **Outside a Store** (a Service's thread, a plain unit test of a helper),
  a report goes to the hook set by
  {rust: `set_bug_hook`}{ocaml: `Bug.set_hook`}{ts: `setBugHook`}, or to standard error.
- Use an assertion instead when continuing would break State's integrity:
  {rust: a panic}{ocaml: an exception}{ts: an exception} faults the Store.
