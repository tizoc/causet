---
title: Authority
summary: What each kind of code may read, change and start.
---

Many bugs in asynchronous code come from code doing more than its job: a
callback that changes State another part thought it owned, a timer that
starts I/O nobody tracks. Causet gives each kind of code exactly one job. A
reducer decides and changes State; an Effect handler starts I/O; an adapter
translates a Service's answer; a lowerer translates a child's report. Each
gets a context that can do its job and nothing else, so most overstepping
is a {rust: compile error}{ocaml: type error}{ts: type error} rather than a race found in
production{ocaml: , and the order inside a reducer is checked as it runs}{ts: , and the order inside a reducer is checked as it runs}.

This page goes through each kind of code: what it may read, what it may
change, and what it may start.

The components talk only through four kinds of message, each with one
producer and one handler:

| Message | Meaning | Produced by | Handled by |
| --- | --- | --- | --- |
| Action | A request to examine and maybe change State. | The Store's caller, reducers, Effect handlers, Event adapters, Output lowerers. | The component's enabling check, then its reducer. Only reducers change State. |
| Effect | A command for a Service. | Reducers only. | The component's Effect handler. |
| Event | A fact from outside: a Service's answer, a network message. | Services, through the Event bus. | The component's adapter, which turns it into Actions. |
| Output | A fact a child reports to its parent. | Reducers. | The parent's lowerer, which turns it into parent Actions. |

```text
Action -> reducer -> Effect -> Service (any thread) -> Event bus
       -> drain_events -> adapter -> Action -> reducer

child reducer -> Output -> parent's lowerer -> parent Action
```

The examples on these pages use
{rust: `causet::guide::shop`}{ocaml: `Causet_guide.Shop`}{ts: `causet/guide`}: a cart, a payment
component and a gateway Service.

{{code shop-opens only=ocaml}}

## Reducers: change State first, then emit

::: rust
A reducer receives a `ComponentContext`. It can change its component's
State, make request IDs and call children inline. Then it trades the
context for a `ComponentEmitter`, which emits Actions, Effects, Outputs and
queued child sends. No API hands out both at once, so nothing a reducer
emits can depend on State it changes afterwards.
:::

::: ocaml
A reducer receives a `Causet.Ctx.t`. It can change its component's State,
make request IDs and call children inline; then it emits Actions, Effects,
Outputs and queued child sends. Once it has emitted, its State is
read-only: a change after an emission raises, and faults the Store. So
nothing a reducer emits can depend on State it changes afterwards.
:::

::: ts
A reducer receives a `Ctx`. It can read `ctx.state` and set a new one
(`set`, `update`; State is immutable, and a child's is written back
through its lens), make request IDs and call children inline; then it
emits Actions, Effects, Outputs and queued child sends. Once it has
emitted, its State is read-only: a change after an emission throws, and
faults the Store. So nothing a reducer emits can depend on State it
changes afterwards.
:::

A reducer can be run on its own with a {rust: `Harness`}{ocaml: `Causet.Harness`}{ts: `Harness`}:
no Store, no Services, its emissions returned in order.
{rust: `Harness::dispatch`}{ocaml: `Harness.dispatch`}{ts: `harness.dispatch`} runs the enabling
check first, as a Store does, and returns
{rust: `Err(Disabled)`}{ocaml: ``Error `Disabled``}{ts: `{ ok: false, error: "disabled" }`} for a refusal;
{rust: `at`}{ocaml: `Harness.at`}{ts: `harness.at`} sets the time, and
{rust: `with_session`}{ocaml: `Harness.create ~session`}{ts: `new Harness({ session })`} the session, to
start from a fixture's.

{{code harness}}

Once {rust: the emitter exists}{ocaml: it has emitted}{ts: it has emitted}, State is out of reach:

{{code state-after-emit}}

A component emits only its own messages:
{rust: `emit_action`}{ocaml: `Ctx.emit_action`}{ts: `ctx.emitAction`} takes its own Action type,
and {rust: `to_child`}{ocaml: `Ctx.to_child`}{ts: `ctx.toChild`} reaches only the children it
declared (see [addressing](addressing.html)).

{{code emit-own-action only=ocaml,ts}}

## Enabling checks and guards: read only

{rust: `Component::is_enabled`}{ocaml: A component's `is_enabled`}{ts: A component's `isEnabled`}, a
slot's admission guard and a root guard are plain functions of State, the
Action and the time. They get no context: they cannot change State, call a Service or
emit. They decide whether an Action runs at all (see
[scheduling](scheduling.html)).

{{code is-enabled}}

## Effect handlers: Services, not State

An Effect handler gets an
{rust: `EffectContext`}{ocaml: `Causet.Effect_ctx.t`}{ts: `EffectCtx`}: its component's
State to read (an {rust: `Option`}{ocaml: option}{ts: `S | undefined`}, since it may be gone by
then), its Service to use, and
{rust: `dispatch`}{ocaml: `Effect_ctx.dispatch`}{ts: `ctx.dispatch`} for an Action that must
run right now, before the handler goes on. It cannot change State and
cannot emit Effects: a reducer decides every Effect.

{{code handler-reads-state}}

A Service is the only place for I/O: storage, network, threads. It never
touches State. It answers by publishing Events through a
{rust: `Reply`}{ocaml: `Causet.Reply.t`}{ts: `Reply`} the handler gave it{rust: , from any
thread}{ocaml: , from any thread}{ts: , at once or later, from a promise or an I/O callback}.

## Adapters and lowerers: Actions only

An Event adapter{rust:  (`Adapts::adapt`)} and an Output lowerer get
{rust: an `ActionPort`}{ocaml: a `Causet.Port.t`}{ts: a `Port`}, which emits Actions and
nothing else. If an Event needs more I/O, the Action it becomes emits an
Effect in the usual way.

{{code port-emits-actions}}

## From outside the Store

The application's own code can do two things: dispatch an Action to a
mount, and send an Event to a mount through the bus. Nothing outside a
reducer can start an Effect.

{{code dispatch-from-outside}}
