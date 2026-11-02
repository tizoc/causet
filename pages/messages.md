---
title: Messages
summary: Declaring Actions, Effects, Events and Outputs: each type's name and each value's kind, what logging records, nesting one message in another, and writing one by hand.
---

Everything a component is asked, asks for, hears back or reports is a
message. Logs, traces, statistics and failing tests all have to say which
message ran, so each one needs a name a person can read, the same from run
to run and from one port to the other.

In causet every message type has a name, such as `cart.action`, and every
value a kind, such as `cart.add`. {rust: The derives write}{ocaml: The deriver writes}{ts: A descriptor, made by `message`, gives}
both from the type you declare, with the level and fields logging
records{ocaml: , and a printer that shows a value as the Rust port prints it}{ts: , and a printer that shows a value as the Rust port prints it}.
Messages need no serialization.

## Four categories

A message's category says what it is for, and so who may send it
([authority](authority.html)):

| Category | What it is | Rust derive | OCaml: given to | TypeScript: given to |
| --- | --- | --- | --- | --- |
| Action | A request to a component: admitted by its enabling checks, then handled by its reducer | `#[derive(Action)]` | `Component.make ~actions` | `component`'s `actions` |
| Effect | A command a reducer gives a Service, carried out by the component's Effect handler | `#[derive(Effect)]` | `Component.make ~effects` | `component`'s `effects` |
| Event | A fact from outside the Store, such as a Service's answer, sent through the Event bus | `#[derive(Event)]` | `Registrar.event`, `Effect_ctx.reply` | `register`'s `r.event`, `ctx.reply` |
| Output | A fact a child reports to its parent | `#[derive(Output)]` | `Component.make ~outputs` | `component`'s `outputs` |

::: rust

Each derive implements `Message` (the type's name, `TYPE`, and each value's
`kind()`) and the category's marker trait, which is what a component's
`type Action`, `type Effect` and `type Output`, and an `Adapts` impl for an
Event, ask for. A message is also `Debug`, `Send` and `'static`. The derives
do not add `Debug`: derive it beside them.

:::

::: ocaml

One deriver, `[@@deriving message ~name:"…"]`, serves all four. For a type
`foo` it defines `foo_message`, a `foo Message.t` that describes every value
of the type (its name, how to tell a value's kind, what logging records, how
to print it), and `pp_foo`, the printer. The category is where the
description goes. A type named `t` gives `message` and `pp`, and a trailing
`_`, as in `effect_`, is dropped: `effect_message`.

:::

::: ts

A message is a discriminated union whose tag is its kind: each value
carries its `kind`, written in full where the value is made, and a
`switch` on it takes the place of a `match`. No deriver is needed.
`message<T>("…", options)` gives the type's descriptor, a `Message<T>`: its
name, and how to read a value's kind, level and logged fields and print
it. The descriptor is also the type's identity at run time: the Store tells
payloads apart by their descriptor, never by their shape. The category is
where the descriptor goes.

:::

Here are a kettle's messages, one of each category:

{{code declare}}

## Names and kinds

The type's name is required: {rust: `#[causet(type = "…")]`}{ocaml: `~name:"…"`}{ts: `message`'s first argument}.
It is never guessed from the {rust: Rust}{ocaml: OCaml}{ts: TypeScript} type's name, so
renaming the type changes no log or statistic, and every port can give a
message the same name.

A value's kind is what logs and statistics count it by, under its type's
name:

- {rust: A variant's kind is a prefix, a `.`, and its
  name in snake case: `kettle.switch_on`.
  Every capital starts a word, so `HTTPGet` gives `h_t_t_p_get`; write
  `HttpGet`.}{ocaml: A constructor's kind is a prefix, a `.`, and its
  name in snake case: `kettle.switch_on`. `Switch_on` and `SwitchOn` both give `switch_on`, as Rust's `SwitchOn` does.
  Every capital starts a word, so `HTTPGet` gives `h_t_t_p_get`; write
  `Http_get`.}{ts: A value's kind is its `kind` tag, written in full where the
  value is made: `{ kind: "kettle.switch_on", target: 100 }`. Nothing is
  derived from a name, and the type checker refuses a tag the union does
  not have.}
- {rust: The prefix is the type's name without its last `.` segment: `kettle.action`
  gives `kettle`, and a name with no `.` is its own prefix.
  `prefix = "…"` sets another.}{ocaml: The prefix is the type's name without its last `.` segment: `kettle.action`
  gives `kettle`, and a name with no `.` is its own prefix.
  `~prefix:"…"` sets another.}{ts: Write the kind the other ports derive, usually the type's name
  without its last `.` segment, a `.`, and the variant's name in snake
  case. Nothing
  checks it, and a trace matches the other ports' only where the kinds are
  the same.}
- {rust: `#[causet(kind = "…")]` on a variant
  gives its kind outright.}{ocaml: `[@kind "…"]` on a constructor
  gives its kind outright.}{ts: A kind that breaks the pattern, such as
  `kettle.heater.off` for a heater's cut, is written the same way: every
  kind is given outright.}
- {rust: A struct has one
  kind: the type's name, unless `kind = "…"` gives
  another.}{ocaml: A record, or any type that is not a variant, has one
  kind: the type's name, unless `~kind:"…"` gives
  another.}{ts: A type of one kind, such as most Events, carries it as its
  tag too, and it need not be the type's name. A type whose values carry
  no tag gives its kind as a function (see writing one by hand, below).}

{{code kinds}}

Kinds need not be unique across types. The shop's Action and Effect that
charge a card are both `payments.charge`; a trace tells them apart by
category and type.

## What logging records

Each message chooses the level it is logged at and which of its fields
appear, so a log shows what matters and leaves out what must not be
logged. Both can be chosen for the whole type and for each
{rust: variant}{ocaml: constructor}{ts: kind}, which wins over the type:

- The level is one of trace, debug, info, warn and error; debug unless
  chosen. It is written
  {rust: `log(level = "warn")`}{ocaml: `~level:Warn` on the type, `[@level Warn]` on a constructor}{ts: `level: "warn"` for the type, `levels: { "door.unlock": "warn" }` for a kind}.
- The fields are named fields {rust: of a struct or a variant}{ocaml: of a record or of a constructor's inline record}{ts: of a value},
  none unless chosen, and written
  {rust: `log(fields(peer, n = count, display(addr)))`}{ocaml: `~fields:peer` on a record, `[@fields peer, n = count, display addr]` on a constructor}{ts: `fields: { "p2p.dial": ["peer", { field: "count", as: "n" }, { field: "addr", display: true }] }`}.
  Each is recorded by its {rust: `Debug`}{ocaml: printer's}{ts: `Debug`} form, so a string
  appears quoted, unless written `display`, which uses
  {rust: `Display`}{ocaml: the display form: a string unquoted, `M.t` by `M.to_string`, `foo` by `foo_to_string`}{ts: the display form: a string unquoted, anything else by `String(value)`}.
  {rust: `n = count`}{ocaml: `n = count`}{ts: `{ field: "count", as: "n" }`} records the field `count` under the name `n`{ts: ; any other field is recorded under its name in snake case, as the Rust port names it, so `dialSecs` as `dial_secs`}. The fields
  of a {rust: enum}{ocaml: variant type}{ts: union} go on its
  {rust: variants}{ocaml: constructors}{ts: kinds}.

{{code logging}}

Observers read both, and the stock logger writes them with every execution:
see [logging](observability.html#logging).

## Nested messages

A {rust: variant marked `#[causet(nested)]`}{ocaml: constructor marked `[@nested]`}{ts: variant named in the descriptor's `nested`}
holds a message of another type, and takes that message's kind, level and
fields. A parent's Action can then carry a child's Actions whole, or one
type can gather the messages of several. The type's name stays the outer
one: statistics count a `lamp.dim` under `room.action`.

{{code nested}}

::: rust

The variant holds exactly one unnamed field, the inner message, as
`Lamp(LampAction)` does.

:::

::: ocaml

The constructor has one argument, a message type: `foo`, whose description
the deriver takes as `foo_message`, or `M.t`, taken as `M.message`. The
p2p example builds its Action this way: an `Intent` holds the Intents a
parent sends, a `Transport` the transport's Events, and each keeps its own
kinds, such as `p2p.dial`.

:::

::: ts

The variant keeps a tag of its own, such as `room.lamp`, and holds the
inner message in the field its `nested` entry names, beside the inner
descriptor: `nested: { "room.lamp": { field: "lamp", message: lampAction } }`.
The tag is what a reducer switches on; the kind, the inner message's, is
what logs and statistics see.

:::

A nested {rust: variant}{ocaml: constructor}{ts: variant} has no kind or logging of its
own: {rust: the derive refuses `kind` and `log` on it}{ocaml: the deriver refuses `[@kind]`, `[@level]` and `[@fields]` on it}{ts: its own entries in `levels` and `fields` are never read}.

## How a message prints

An observer can print any payload. {rust: It prints a message by its `Debug` form, from `#[derive(Debug)]`, which every field's type needs as well.}{ocaml: It prints a message with its description's printer, through `Message.pp_payload`.}{ts: It prints a message with its descriptor's printer, through `debugPayload`.}
The ports print a payload alike, in Rust's `Debug` form:
`Lamp(Dim { percent: 40 })`.

::: ocaml

The printer the deriver writes prints each field with the printer of the
field's type, found by name: `pp_foo` for a field of type `foo`, `M.pp` for
`M.t`, `M.pp_foo` for `M.foo`. The `Debug` module has them for the base
types (`int`, `string`, `bool`, `float`, `char`, `bytes`, …), and the
deriver itself handles lists, arrays, options and tuples of printable types.
Any other field type needs its printer in scope, so a first real message
type usually needs one of these:

- `[@@deriving debug]`, which makes the printer alone, for a type a message
  holds;
- a printer written by hand with the `Debug` module's `tuple`, `record` and
  base printers, which print in the same form;
- `[@debug_name "…"]` on a constructor, the name to print for it, when the
  OCaml name differs from the Rust one. The constructors of two types in one
  module cannot share a name, so an Effect that carries out an Action of
  the same name is named apart, and keeps the Rust port's kind with
  `[@kind]` and its printed name with `[@debug_name]`.

A type the deriver cannot print, such as an abstract one, takes one of two
options. `~pp:<printer>` gives the printer by hand, a function of type
`Format.formatter -> <type> -> unit`: it is bound as `pp_<type>`, so the
message and the printers of types that hold this one all use it, and it may
name the type's own constructors and fields. `~pp:Causet.Debug.opaque` is
the one-liner for a type whose values print as `_` but that other types
hold. `~no_pp` leaves the printer out altogether: the message's values
print as `_`, and a type that holds this one needs a printer of its own.

:::

::: ts

The printer reads a value's shape and prints it as Rust's `Debug` prints
the type it stands for: a tagged value as the variant its kind names (the
last segment in CamelCase: `lamp.dim` is `Dim`), with its other fields in
order, each under its name in snake case as the Rust port names it
(`steepSecs` prints as `steep_secs`); a string quoted, a whole number as an
integer, an array as a list, `undefined` as `None`. Where the Rust name is
not the one the kind tells, as for a variant whose kind is given in full or
a struct of one kind, the descriptor's `debugNames` gives it. A value of a
class that should print otherwise, such as a newtype, prints itself with a
`[debugCustom]` method, written with the `Debug` module's printers. A form
no shape tells takes a printer by hand, the descriptor's `debug` option: a
tuple variant, a float that holds a whole number (Rust's `4.0`), or an
optional field that holds a value (Rust's `Some(4)`). Since a kind is not a
TypeScript name, an Action and an Effect of the same name need nothing
apart.

:::

{{code printers only=ocaml,ts}}

## Writing one by hand

The {rust: derives cover}{ocaml: deriver covers}{ts: descriptor's defaults cover} variants and
{rust: structs}{ocaml: records}{ts: tagged values}. When a kind depends on more than the
{rust: variant}{ocaml: constructor}{ts: tag}, write the description yourself.

::: rust

Implement `Message`: `TYPE` and `kind()`, and `log_level()` and
`log_fields()` when they are not the defaults (debug, and no fields). Then
implement the category's marker trait, which has no methods. The timer's
Event, `TimerFired`, is written this way, and so is the p2p example's
Action: a struct around a private enum, so that a parent can build only an
Intent, with a kind for each variant of the enum inside.

:::

::: ocaml

Build the `Message.t` yourself. `Message.make ~name ~kind ()` takes a
function from a value to its kind, and `~level`, `~fields` and `~pp` when
they are not the defaults (debug, no fields, and a printer of `_`).
`Message.single name` is a type of one kind, its name. The timer's Event,
`Timer.fired`, is made this way.

:::

::: ts

Give `message` the kind as a function, `kind: (value) => …`, as a type
whose values carry no tag must; and `level`, `levels`, `fields` and
`debug` when they are not the defaults (debug, no fields, and the printer
that reads the value's shape).

:::

{{code by-hand}}

## What fails to compile

{rust: The derives refuse}{ocaml: The deriver refuses}{ts: The type checker refuses}, at compile time,
anything that would otherwise be guessed or left out:

- a type with no name;
- {rust: a nested variant that holds anything but exactly one unnamed field,
  and a nested one with a `kind` or a `log`;}{ocaml: a nested constructor that holds anything but one argument of a message type,
  and a nested one with a `[@kind]`, `[@level]` or `[@fields]`;}{ts: a kind the union does not have, in a value or as a key of `levels`,
  `fields` or `nested`;}
- an {rust: attribute}{ocaml: attribute}{ts: option} it does not know, such as a misspelt {rust: `#[causet(knd = "…")]`}{ocaml: `[@causet.knd]`}{ts: `levles`};
- {rust: a type-level `kind` on an enum:
  give the variants kinds, or set the prefix;}{ocaml: a type-level `~kind` on a variant type:
  give the constructors kinds, or set the prefix;}{ts: a type whose values carry no `kind` tag, unless its kind is given
  by hand;}
- {rust: logged fields for a whole enum, or fields
  that are not named.}{ocaml: logged fields for a whole variant type, or fields
  that are not named.}{ts: a logged field that values of its kind do not have.}

{{code refused-no-type only=rust,ts}}

{{code refused-nested only=rust}}

::: ocaml

A type with no name fails with
`[@@deriving message] needs ~name, the type's name`; a nested
constructor of no argument, or of several, with
`a nested constructor holds exactly one message`; and one with a kind with
`a constructor is either [@nested] or has a [@kind], not both`. Each error
points at the attribute or option at fault.

:::
