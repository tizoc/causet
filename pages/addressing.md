---
title: Addressing
summary: Mounts, paths, child slots, Outputs and replies, and where context and Effects belong.
---

As an application grows, you want to write a component once and use it in
several places: a counter under two parents, a P2P component inside a
node. And you want each copy kept apart, with its own State, its own
requests and its own answers. This page explains how components nest and
how messages find their way: how a parent calls a child, how a child
reports back without knowing its parent, how a Service's answer returns to
the copy that asked, and where an Effect should live.

Components form a tree. A component is written once and *mounted* wherever
a parent declares a slot for it; each mount has its own State (projected
from its parent's by a lens), its own Service (likewise) and its own
identity. Messages travel only along the tree: a parent calls its declared
children, a child reports to its parent with Outputs, and Services answer
the mount that asked.

## Paths and instance identity

The root is mounted at `/`. A slot named `cart` under it is `/cart`; a
component mounted at two slots is two mounts with two paths. Each mount's
{rust: `InstanceId`}{ocaml: instance ID}{ts: `InstanceId`, a `bigint`,} is the 64-bit xxh3 hash (seed 0)
of its path: the same in every run and every build, and the same in all three ports, so it can be logged, stored and carried in messages. Two paths that
hash alike are refused when the Registry is frozen.

From outside the Store, a mount is reached through a typed path built from
slots, resolved once into a {rust: `Mount`}{ocaml: `Causet.mount`}{ts: `Mount`}: by the Store,
{rust: `store.mount(&path)`}{ocaml: `Store.mount store path`}{ts: `store.mount(path)`}, or by the Protocol it runs, as here:

{{code resolve-mount}}

A mount belongs to the Protocol that resolved it. Any Store built from that
Protocol accepts it, and every other Store refuses it:

{{code foreign-mount}}

## Child slots: inline and queued calls

A component declares each child as a slot,
{rust: a typed constant `Child<Parent, Child>`}{ocaml: a value made by `Child.make`}{ts: a `Child<P, C>` made by `child<P>()(name, component)`},
and binds it in its own `register`: the State lens, the Service
{rust: lens}{ocaml: projection}{ts: projection} if the child has Effects, an optional
admission guard, and an Output lowerer if the child has Outputs. The slot's
type names its parent, so only the declaring component can use it.
{ts: In TypeScript the slot's type names its parent's State: another component
of the same State type also accepts it, and using it where it is not bound
throws, which faults the Store.}

A reducer then calls a child in one of two ways:

- **Queued**, {rust: `out.to_child(SLOT, action)`, from the emitter}{ocaml: `Ctx.to_child ctx slot action`, an emission}{ts: `ctx.toChild(slot, action)`, an emission}:
  the ordinary way. The Action joins the FIFO and runs as its own
  execution when its turn comes, admitted by every check on its way in.
- **Inline**, {rust: `ctx.reduce_child(SLOT, action)`}{ocaml: `Ctx.reduce_child ctx slot action`}{ts: `ctx.reduceChild(slot, action)`},
  for a parent that must act on the result in the same execution, while it
  still changes State. The child's checks and reducer run right there,
  inside the parent's execution, and the call reports whether the child
  ran. The parent carries on afterwards, knowing the result. The child's
  slot guard and own check run as on any route; a root guard runs only when
  the root itself is the caller (see [admission](scheduling.html#admission)),
  so a parent below the root that calls inline takes on what the child's
  root guard checks.

{{code pair}}

{{code pair-run only=ocaml}}

Slots name immediate children only: a component cannot reach its siblings,
its parent or its grandchildren. A grandparent that must gate a grandchild
does it through the child's guard on its own slot. The application can also
gate any mount on its whole State, with a root guard (see
[admission](scheduling.html#admission)).

## Outputs: children report, parents decide

A child that must tell its parent something emits an Output, a fact such as
{rust: `CheckedOut { total }`}{ocaml: `Checked_out { total }`}{ts: `{ kind: "cart.checked_out", total }`}. The
parent's lowerer for that slot turns it into parent Actions, in place: a
child never names its parent's Actions, so it can be mounted under any
parent. In the shop, the cart's {rust: `CheckedOut`}{ocaml: `Checked_out`}{ts: `cart.checked_out`}
becomes the root's `Pay`:

```text
Child emits:     Action A, Output O, Effect E
Parent lowers O: Action P, Action Q
FIFO:            A, P, Q, E
```

A lowerer is a plain function with {rust: an `ActionPort`}{ocaml: a `Port.t`}{ts: a `Port`}
for the parent: no State, no Service. Ignoring an Output must be an
explicit match {rust: arm}{ocaml: case}{ts: case in the lowerer, which a slot whose child has
Outputs must bind}. There is no broadcast: siblings
coordinate through their parent.

## Replies: a Service answers the mount that asked

An Effect handler gives its Service a {rust: `Reply<Ev>`}{ocaml: `Reply.t`}{ts: `Reply<Ev>`}.
The Service can keep it, {rust: move it to a worker thread}{ocaml: move it to a worker thread}{ts: hand it to a callback} and send through it
later; the Event goes to the adapter of the mount whose Effect made the
reply, even when several mounts share one Service. A reply can only be made
for an Event the component adapts:
{rust: this is checked at compile time.}{ocaml: `Effect_ctx.reply` raises otherwise.}{ts: `ctx.reply` throws otherwise.}

To recognise its answer, a reducer makes a request ID
({rust: a `RequestId`}{ocaml: `Ctx.new_request`}{ts: `ctx.newRequest()`}) while it changes State,
stores it, and puts it in the Effect; the Service returns it in the Event.
An answer whose request is no longer pending is stale, and the reducer
ignores it. That is also how a timeout cancels a request: forget it. The
`Timer` Service delivers {rust: a `TimerFired`}{ocaml: a `fired` Event}{ts: a `TimerFired`}
for a request after a delay, the same way.

`Pending` keeps those requests in State: for each, what the reducer needs
to handle its answer, and an optional deadline. The first of the answer and
the timer pinned to the request takes it
({rust: `Pending::take`}{ocaml: `Pending.take`}{ts: `pending.take`}); the second finds nothing
and is stale. A component that keeps one timer for its earliest deadline
arms it at {rust: `Pending::next_deadline`}{ocaml: `Pending.next_deadline`}{ts: `pending.nextDeadline()`}
and, when it fires, takes what is due with
{rust: `Pending::expire`}{ocaml: `Pending.expire`}{ts: `pending.expire(now)`}. The shop's payments
keep their charges in a `Pending` table, with no deadline; the
[timeouts](timeouts.html) page shows both ways of keeping deadlines.

Input that answers no Effect, such as a message from the network, is sent
to a mount directly through the bus's
{rust: `EventSink`}{ocaml: `Sink.t`}{ts: `Sink`}, {rust: from any thread}{ocaml: from any thread}{ts: at any time}:

{{code duplicate-answer}}

Only a component that adapts an Event can be sent one{ocaml: ; the Event is handed back}{ts: ; the Event is handed back}:

{{code send-unadapted}}

## Context from the parent

A component sees its own State only. When its decision depends on the rest
of the application (a balance a sibling keeps, whether a request is still
open, which inputs another part already spent), the parent, which can read
it, computes that fact and passes it in the child's Action. The child stays
a pure transition of its own State and the Action; the fact it decided on is
in the Action, so it shows in the trace and a test can give the child any
context without building the rest of the application. Requests the other
way leave as Outputs, which the parent lowers.

{{code wallet}}

{{code wallet-run only=ocaml}}

A check that only reads the parent's State, and only says yes or no, can be
a guard on the slot instead; a fact the child's reducer works with goes in
the Action.

## Where an Effect belongs

A reply returns to the mount whose Effect made it, and its Event is adapted
and reduced there, with that component's view. So put an Effect on the
component that can interpret its answer. If understanding the answer needs
State the component cannot see (whether the request it answers is still
wanted, what changed meanwhile), the Effect belongs to the parent: the
parent issues it, adapts the answer, and passes the child what it decided,
as above. Usually that leaves the child with no Effects at all: a lifecycle
of its own State, driven by its parent.

The {rust: `wallet-send`}{ocaml: `wallet_send`}{ts: `wallet-send`} example in the repository
is built this way: the wallet-send component holds a send's lifecycle; the
root holds the RPC requests, the chain's root and the mempool, issues every
read and the proving, and tells the component, with each answer, whether
its attempt is still current.
