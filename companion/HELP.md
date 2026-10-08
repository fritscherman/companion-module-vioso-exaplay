## VIOSO Exaplay 3

Controls an Exaplay 3 engine: composition transport, cue lists with one key
per cue, command buttons, Stream Deck+ dials (volume, opacity, seek, cue
picker, master volume), Show mode, Blank, Spaces pages, projectors, Inputs —
with live status on the buttons.

### Configuration

| Field | Default | |
|---|---|---|
| Engine address | — | The engine's IP address. In a multi-client rig, the **master**. |
| TCP port | 8100 | Exaplay → Settings → Communication → **TCP Listen**. |
| HTTP port | 8123 | The web UI's port. Carries the status feed, command buttons, projectors and Stop all. |
| OSC port | 8000 | Exaplay → Settings → Communication → **OSC Listen**. |
| OSC prefix | `exaplay` | Exaplay → Settings → Communication → **OSC Prefix**. |
| Use the status feed | on | Off = commands only; feedbacks stay unlit and status variables read `?`. |
| Status rate | 5 | Status messages per second, 1–20. |

The firewall on the Exaplay machine must let in TCP 8100, TCP 8123 and UDP 8000.
For several Exaplay engines, add one connection per engine.

### Which connection does what

- **TCP 8100** (one connection, kept open, reconnects by itself): play, pause,
  stop, toggle, next, previous, cue go, jump / seek, volume, opacity, loop,
  Show mode, Blank (+ fade), blank fade, Audio mute, Identify, Play all,
  Spaces page, engine restart, Inputs values, raw commands — and the
  reading of the cue lists (in the background; it never delays a key press).
- **WebSocket 8123 `/status`**: everything the buttons and variables show.
- **HTTP 8123**: *Command button: press* (`POST /control/fire` — it sends the
  button's **ID** only; the commands are the ones stored in the project), the
  list of command buttons (read only), *Projectors: power all*, *Stop all*,
  the master volume, *Inputs: switch rule groups*.
- **OSC 8000**: Outlines, correction bypass, Timeline frame jump — and, when
  the connection's *Blank, Audio mute, Identify, Play all over* is set to
  *OSC* for an engine older than 3.4, those too. OSC has no reply: the feedback (from
  the status feed) is how you see that it worked.

### Compositions

Pick a composition from the list (filled from the status feed and from the
engine's composition list), or type its **ID** (`comp1`, shown in the
composition's Inspector) or name in the text field — the text field wins when
it is not empty. A name containing `.` or `,` cannot be used; use the ID.

**Cue go** takes a cue index (Timeline: the cue's index; Playlist: the
1-based item) or a cue **name**. A purely numeric value is always an index.
**Cue: go (pick from the cue lists)** offers every cue of every composition.

**Play/pause toggle** needs the status feed: while the composition's state is
unknown it sends nothing and logs why.

### Cue lists

The module reads each composition's cues when it connects, after a project
load, when the project or its compositions change, and when you run
**Refresh cue lists and command buttons**. `$(exaplay:lists_state)` says
`ok`, `refreshing`, `?` (not read yet) or the error. A cue renamed in Exaplay
appears after a refresh; keys you already placed keep their text.

- Folder **Cues: <composition>** — one GO key per cue. It lights **green**
  while that cue is the current one and **amber** while it is the next one.
- Feedbacks *Cue: is the current cue* and *Cue: is the next cue* for your own
  keys. A Timeline's next cue is the first one after the playhead; a
  Playlist's is the item after the playing one (with nothing playing: the
  first).

### Command buttons

The **Command buttons** folder has one key per command button of the project;
*Command button: press* lists them too. You can still paste an ID into the
text field (Control tab → select the button → Inspector → **ID**). A press
that the engine refuses (already running, no commands, a client machine)
lights the key red (*Command button: its last press failed*) and the reason
is in `$(exaplay:button_last)`. A client machine of a multi-client rig
refuses command buttons — address the master.

While a button's commands are running — its `WAIT>` lines included — its key
turns **amber** (*Command button: its commands are running*). The engine
reports this in its status feed, so the key lights whoever pressed the button:
this Stream Deck, the Control tab, a User Panel or another controller.
`$(exaplay:buttons_running)` lists the running IDs (`-` none, `?` unknown —
an engine too old to report it, or no status feed; the key then stays unlit).

### Dials (Stream Deck+)

The **Dials** folders hold dial presets (turn left / right, press):

- **Volume** and **Opacity** of a composition, ±2 per detent.
- **Seek**, ±1 s per detent; press = play/pause.
- **Cue picker**: turning only **picks** a cue (shown on the dial, purple
  while it waits); pressing sends that one cue. Nothing fires while you turn.
- **Master volume** (Dials: engine) — this machine's own, never pushed to
  clients.

A dial never guesses where it starts: the first turn reads the current value
from Exaplay, then continues from what it sent. After a 2-second pause it reads
again, so a change made in Exaplay in between is respected. If the value
cannot be read, the turn is dropped and `$(exaplay:last_error)` says why. A
fast turn sends a few values, not one per detent, always ending on the last.

The same actions work on ordinary keys: *nudge* with a step of +5 / −5, or
*set* a fixed value (*learn* fills in the current one).

### Other actions

*Composition: jump to a time* (seconds or `m:ss`), *seek ± seconds*,
*Timeline: jump to a frame*, *loop*, *VIOSO Spaces: show a page* (next, prev,
first, last, a number or a page ID), *Projectors: power all on / off*,
*Correction bypass* (raw wall), *Blank fade time*, *Engine: restart* (sent
only when its confirmation box is ticked), *Inputs: send a value to a
channel* / *nudge a channel value* / *switch rule groups*, *Send OSC to the
engine*, *Send an HTTP request to the engine*, *Re-sync*, *Clear last error*.

### Nothing is ever resent

A command that gets no reply in 3 seconds (Exaplay drops commands while a
project loads) is reported as failed in the log and in `$(exaplay:last_error)`
— it is **not** sent again, because the engine may have acted on it. Press
again if needed.

### Variables

`connection`, `tcp_state`, `status_state`, `loading`, `project_name`,
`project_unsaved`, `show_mode`, `blank`, `blank_fade`, `audio_mute`,
`identify`, `outlines`, `correction_bypass`, `show_page`, `composition_count`,
`master_volume`, `lists_state`, `button_count`, `button_last`, `last_reply`,
`last_error`, and for every composition (`<id>` = its ID, e.g. `comp1`):

| `comp_<id>_…` | |
|---|---|
| `name`, `state`, `playing` | name; playing / paused / stopped; on / off |
| `time`, `time_s`, `time_hms`, `time_mmss` | position as M:SS.t, seconds, H:MM:SS, MM:SS |
| `duration` | Timeline length |
| `remaining`, `remaining_s`, `remaining_hms`, `remaining_mmss` | Timeline: to its end; Playlist: to the end of the item (rounded up) |
| `progress`, `progress_bar` | percent, and a text bar `▰▰▰▱▱▱` |
| `cue_name`, `cue_index` | current cue / playing item |
| `next_cue_name`, `next_cue_index`, `next_cue_in` | the next cue and the time to it |
| `item_remaining` | Playlist item remaining |
| `cue_count` | cues / items in the list |
| `selected_cue_name`, `selected_cue_index` | the cue picked with the cue dial |
| `volume`, `opacity` | as last read or set by this module |

`?` means **unknown** (no status feed, a list not read, or the engine did not
say); `-` means the engine said there is **none** (no cue passed yet, no next
cue). A Timeline's remaining time and progress need an Exaplay that reports
the Timeline's length; with an older engine they read `?`.

### Feedbacks

Composition state / unknown, *time running out* (remaining below N seconds →
red), *progress colour* (green → amber → red near the end), cue current /
next / picked, Show mode, Blank, Audio mute, Identify, Outlines, correction
bypass, loading, connected, **connection lost** (flashes red), status unknown,
command button failed.

### Presets

*Show*: Blank, Show mode, Stop all, Play all, Audio mute, Identify, Outlines,
raw wall, projectors on / off, Spaces page ◀ / ▶, Connection (flashes red
when lost), Refresh lists, Re-sync, Last error. *Transport: <composition>*:
Play, Pause, Stop, Play/pause with time, Previous, Next, current cue with
countdown, remaining time, next cue, seek −10 s / +10 s, back to the start.
*Cues: <composition>*, *Command buttons*, *Dials: <composition>* and
*Dials: engine* as above.
