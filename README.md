# companion-module-vioso-exaplay

> Developed in the Exaplay repository under `integrations/companion`; this
> repository is its standalone copy for Bitfocus's module list. Change it
> there first, or keep both in step.

# Bitfocus Companion module — v1.3.0

**Validation: unit-tested; not run inside Companion or against an engine.**
The command builders, the reply and cue-list parsers, the status reducer, the
throttle, the dial and the time formatting are covered by `node --test`; the
TCP client, the status client, the HTTP requests, the cue-list/command-button
refresh and the instance wiring (`src/main.js`, with Companion's `InstanceBase`
replaced by a recording stand-in) are exercised against local mock servers.
Nobody has yet loaded this module into a running Bitfocus Companion, turned a
Stream Deck+ dial with it, or pointed it at a real Exaplay engine. Every wire
command below was checked against the API references and, where those are
silent, the engine source — that is a reading, not a test. See
[`compatibility.json`](compatibility.json) and the commissioning checklist
below.

A module for [Bitfocus Companion](https://bitfocus.io/companion) 3.x (module
API `@companion-module/base` 1.14, runtime `node22`, plain CommonJS) that puts
Exaplay on a Stream Deck: composition transport, cue lists with one key per
cue, command buttons, Stream Deck+ dials for volume / opacity / seek / cue
picking, Show mode, Blank, Spaces pages, projectors, Inputs — with live status
on the keys. The operator-facing help is [`companion/HELP.md`](companion/HELP.md)
(Companion shows it behind the module's **?**).

## Install

### A — import the package (Companion 4, recommended)

1. Get `vioso-exaplay-<version>.tgz`: from the **companion-module-vioso-exaplay**
   artifact of the *Integrations tests* CI run, or build it yourself
   (`npm ci` then `npm run package` in this folder, Node 22).
2. In Companion: **Modules** → **Import module package** → choose the `.tgz`.
3. **Connections → Add connection** → search for *Exaplay* → enter the engine's
   address. In a multi-client rig, use the **master**. For several engines add
   one connection each; they share nothing.

Nothing has to be installed on the Companion PC — the package carries its
dependencies.

### B — as a developer module (for working on the module)

1. Copy this whole folder (`integrations\companion`) to a writable place, e.g.
   `C:\CompanionModules\exaplay` (the copy the Exaplay installer puts under
   `C:\Program Files\Exaplay 3\integrations\companion` is read-only and has no
   dependencies installed).
2. In that folder run `npm ci` (Node 22). Without `node_modules` Companion
   cannot start the module.
3. In Companion: the launcher window's cog → **Developer modules path** →
   choose the folder that **contains** `exaplay` (`C:\CompanionModules`), then
   restart Companion.

The module is built against `@companion-module/base` 1.14 with the `node22`
runtime, i.e. Companion 4.x — as far as the Companion release notes go; it has
not yet been loaded into a running Companion.

### Publishing in Companion's module list

The module is prepared for Bitfocus's process: package name and manifest id
`vioso-exaplay`, repository `bitfocus/companion-module-vioso-exaplay`, MIT
licence, `npm run check` (Companion's own manifest check) and `npm run
package` green in CI. To publish:

1. Ask for the repository in the Bitfocus Slack, channel **#module-development**
   (GitHub user name + `vioso-exaplay`). Push this folder there as the
   repository root.
2. Per version: raise `version` in `package.json`, tag `v<version>`.
3. In the **Bitfocus Developer Portal**: log in with GitHub → *My Connections*
   → the module → *Submit Version* → pick the tag. Volunteers review it.

Before the first submission, run the commissioning checklist below on a real
Companion against a real engine.

## Features and the wire commands behind them

"Ref" is where the command is documented; **src** means the reference docs do
not list it and it was verified in the engine source named.

| Feature | Transport | Wire form | Ref |
|---|---|---|---|
| Play / pause / stop | TCP 8100 | `comp1.play`, `comp1.pause`, `comp1.stop` | tcp-api |
| Play/pause toggle | TCP | `comp1.pause` if the status says playing, else `comp1.play`; **nothing** while unknown | tcp-api |
| Next / previous | TCP | `comp1.next`, `comp1.prev` (Playlist: item; Timeline: cue marker) | tcp-api |
| Cue go (index / name / picked from the list / per-cue preset) | TCP | `comp1.cue.go=3`, `comp1.cue.go=Blackout` | tcp-api |
| Cue lists | TCP, background queue | `get:complist`; `comp1.get:type` (`timeline`/`cuelist`/`composition`); `comp1.get:cuelist` (Timeline `idx,name,offset`; Playlist `idx,name,file`; then `END`) | tcp-api; formats: src `project/exaplay-project-Composition.cpp` |
| Jump to a time / seek ± s | TCP | `comp1.set:time=75.5` (Playlist: within the current item) | tcp-api |
| Timeline frame jump | OSC 8000 | `/exaplay/comp1/frame ,i 750` | osc-api |
| Volume / opacity set, nudge, learn | TCP | `comp1.set:vol=80`, `comp1.set:alpha=50` (0–100); read `comp1.get:audio.volume`, `comp1.get:alpha` (stored value) | tcp-api; generic getter: src `exaplay-obj.cpp` |
| Loop on / off / toggle | TCP | `comp1.set:loop=on\|off`; toggle reads `comp1.get:loop` first | tcp-api |
| Engine master volume | HTTP 8123 | `POST /data {"type":"exaObj","path":"global","values":{"audio-volume":v}}`; read `GET /data?type=exaObj&path=global&values` | rest-api (`/data`), custom-web-interfaces `master` |
| Show mode | TCP | `system.showmode=on\|off\|toggle` | tcp-api |
| Spaces page | TCP | `system.showpage=next\|prev\|first\|last\|<n>\|<id>` | **src** `project/exaplay-project-System.cpp`, `engine-comm/comm-showpage.cpp` |
| Engine restart (confirmation required) | TCP | `system.restart`, `system.restart=clean` | tcp-api |
| All projectors on / off | HTTP | `POST /cmd {"req":"pjlink-all","parameter":"1"\|"0"}` → `{"message":"OK,n/m"}` | rest-api |
| Stop all | HTTP | `POST /stop` | rest-api |
| Command button press | HTTP | `POST /control/fire {"id":"…"}` — names the button, never carries a script | rest-api |
| Command button list (read only) | HTTP | `GET /data?type=exaObj&path=project&values` → `control_panel_items[]` of `type:"script"`; only `id` and label are kept | rest-api (`/data`); shape: src `engine-comm/comm-control-script-rules.h` |
| Blank (+ fade) | TCP (OSC on an older engine) | `system.blank=on\|off\|toggle[,<seconds>]` — OSC: `/exaplay/global/videomute ,s[f] …` | tcp-api, osc-api |
| Blank fade time | TCP (OSC on an older engine) | `system.blankfade=<seconds>` — OSC: `/exaplay/global/blankfade ,f seconds` | tcp-api, osc-api |
| Audio mute / Identify | TCP (OSC on an older engine) | `system.audiomute=…`, `system.identify=…` `on\|off\|toggle` — OSC: `/exaplay/global/audiomute`, `…/identify` | tcp-api, osc-api |
| Outlines / correction bypass | OSC | `/exaplay/global/showguides`, `…/correctionbypass` `,s on\|off\|toggle` | osc-api |
| Play all | TCP (OSC on an older engine) | `system.playall` — OSC: `/exaplay/global/start` | tcp-api, osc-api |
| Inputs: send to a channel, nudge a channel | TCP | `track,<ch>,<x>[,<y>]`, `track,<ch>,x\|y,<v>`, `track,<ch>,click[,<v>]` | tcp-api, inputs |
| Inputs: switch rule groups | HTTP | `POST /tracking {"command":"group:<g>=on\|off\|toggle"\|"solo=<g>"\|"all=on\|off"}` | rest-api, inputs |
| Raw TCP / OSC / HTTP to the engine | TCP / OSC / HTTP | one line; an OSC address + `i:`/`f:`/`s:` args; GET/POST a path with a JSON body — always to the configured engine, never another host | — |
| Status | WebSocket 8123 | `ws://<engine>:8123/status`, protocol v1 (+ per-composition `duration` when the engine sends it) | status-api |

Blank, the blank fade, Audio mute, Identify and Play all go over TCP on
Exaplay 3.4 and later (`system.blank=` …), so a refused line shows up in
`$(exaplay:last_error)`. For an older engine, set **Blank, Audio mute,
Identify, Play all over** to *OSC* in the connection's settings. Outlines and
the raw wall always go over OSC (they have no TCP verb). OSC has no reply, so
there the status feed is the confirmation. A fade sent with Blank also
**becomes** the rig's blank fade time for later blanks, exactly as the OSC
reference says.

`pjlink-all` goes over HTTP rather than `system.pjlink-all=` on TCP on purpose:
the engine powers the projectors one after another (1.5 s connect timeout
each), and on the single TCP connection that would hold every GO behind it.

### Asked for, not offered (the engine has no such command)

- **Per-cue duration / a cue's own remaining time.** Neither `/status` nor the
  TCP API reports how long a Timeline cue "lasts"; the module offers the time
  to the next cue (`next_cue_in`), the Timeline's remaining time (needs the
  `duration` key) and the Playlist item's remaining time.
- **Correction bypass, blank, identify over TCP.** No TCP verb exists; OSC is used.
- **Reading an Inputs channel's current value over TCP.** The Inputs nudge
  keeps the module's own value, starting from the action's start value.
- **Seeking a Playlist across items.** `set:time` addresses the current item only.
- A Spaces page change that is refused (already on the last page, no pages)
  answers `ERR,command_failed` on TCP; the engine's reason is in its log /
  Monitor, not in the reply.

## Behaviour that matters in a show

- **One TCP connection**, reconnected with backoff (1 s, 2 s, 4 s … 30 s).
  Replies carry no request id, so exactly one command is in flight.
- **Nothing is resent.** Exaplay drops commands without a reply while a project
  loads. A command with no reply in 3 s is reported as failed and is not sent
  again — the engine may have acted on it, and a repeated *next* moves twice.
  Before the next command the client sends `hello` and discards everything up
  to `hallo`, so a late reply cannot be read as the answer to a later command.
- **A command while the link is down fails at once**; it is not queued, because
  a GO that fires half a minute later is worse than one that visibly failed.
- **Background reads wait behind every operator command.** The cue-list refresh
  (`get:complist` plus up to four lines per composition) is served only when nothing an operator
  pressed is waiting.
- **Dial writes go through a throttle**, never a debounce: the first detent
  goes out at once, one write is in flight, and while it is the latest value
  replaces the others. Only absolute values are sent (`set:vol=72`, never "+2"),
  so a lost reply cannot move anything twice.
- **A nudge needs a known base.** With no known value the dial reads the engine
  first (`get:audio.volume`, `get:alpha`, master volume via `GET /data`, the
  status time for a seek) and applies the turns made meanwhile; if the read
  fails, the turn is dropped and reported. While the dial is being worked the
  module's own value is the base (2 s; a seek 1 s), after a pause it reads
  again, so a change made in the Exaplay UI is not overwritten from an old base.
- **The cue dial** picks a cue without sending anything; pressing it sends one
  absolute `cue.go=<index>`. A dial that spun through ten cues therefore never
  fires ten `next`s.
- An idle link is probed with `hello` every 15 s; no answer → reconnect.
- **Unknown is never evidence.** While the status feed is down, a key is absent,
  a list was not read, or a value has the wrong type, variables read `?` and
  boolean feedbacks stay unlit; `-` means the engine said "none". A full status
  message replaces the previous one. A Timeline's remaining time reads `?` on an
  engine that does not send `duration`. A cue list that could not be read is
  unknown (no cue presets), never "no cues".
- **Lists follow the project**: they are re-read on connect, after a project
  load (`loading` true → false), when the project name changes, when the status
  feed's composition list differs from the one read (once per distinct list),
  when the feed comes back after a loss, and on *Refresh*. A project change
  forgets the picked cues and the known levels.
- An engine without `/status` (older than this module) still takes every
  command; the instance shows a warning, the status reads unknown, and the cue
  lists / command buttons still come from TCP and HTTP.
- **Several engines** = several connections. All state lives on the instance;
  variables and feedbacks are namespaced by Companion per connection label.

## Layout

```
companion/manifest.json   Companion manifest (apiVersion 0.0.0 = developer mode)
companion/HELP.md         operator help shown inside Companion
src/main.js               InstanceBase subclass: wiring, refresh triggers, dials
src/config.js             config fields
src/actions.js  src/feedbacks.js  src/variables.js  src/presets.js  src/options.js
src/lib/                  NO Companion dependency:
  commands.js             command builders (TCP lines, OSC messages, HTTP requests) + answer parsers
  reply.js                CRLF line splitter, reply classification, complist rows
  cues.js                 cue-list rows, type replies, next / current cue, command-button list
  catalog.js              the refresh: compositions, cue lists, levels, command buttons
  throttle.js             latest-value throttle (one in flight, never a debounce)
  dial.js                 a set/nudged value with a known base
  status.js               /status v1 parser → state → variables / choices
  format.js               time / boolean / progress formatting (unknown vs none)
  tcp-client.js           the persistent TCP client (+ background queue)
  status-client.js        the /status WebSocket client
  http.js  backoff.js
tests/                    node --test
```

## Tests

```sh
cd integrations/companion
npm ci
npm test            # node --test
```

`ws` and `@companion-module/base` are needed for the mock-server and
definition tests. These tests are not part of any CI workflow — the
repository's Actions run the backend compile check and the frontend suite only.

## Commissioning checklist (not yet done)

1. Load the module as a developer module; the connection turns green with a
   reachable engine and shows *Commands OK; status feed not connected* against
   an engine without `/status`. `$(exaplay:lists_state)` reads `ok`.
2. Every action on a sample project (`comp_main` Timeline, `comp_lobby`
   Playlist, cue 3 / `Blackout`, one command button), watched in Exaplay's
   **Control → Monitor**. The **Cues** folders list the project's cues, the
   **Command buttons** folder its buttons.
3. Feedbacks and variables follow changes made in the Exaplay UI (play, blank,
   show mode, current cue) within one status interval; the next-cue key moves
   on as cues pass.
4. On a Stream Deck+: turn the volume dial fast — the Monitor shows a few
   `set:vol=` lines, not one per detent, ending on the value the key shows;
   change the volume in the Exaplay UI, wait 3 s, turn again — it continues
   from the UI's value. Turn the cue dial, then press — exactly one `cue.go`.
5. Load another project: the cue presets and dropdowns follow it.
6. Pull the network cable for 30 s and put it back: both links come back by
   themselves, values read `?` meanwhile, the connection key flashes red,
   nothing fires twice.
7. Load a project while pressing keys: commands report "no reply … not resent";
   none of them is executed late.
8. Against an engine that sends `duration`: the remaining-time key counts down
   and turns amber / red near the end; against one without it, it reads `?`.
