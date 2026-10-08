# Changelog

## 2.0.0 - 2026-10-08

Still unit-tested only — not yet run inside Companion or against an engine.

- **The update of the module already on Companion's list.** `vioso-exaplay`
  1.x (TCP polling) becomes this module: an upgrade script moves a 1.x
  connection's config, actions and feedbacks to their 2.0 equivalents
  (`1` still means `comp1`), keeps the five 1.x display feedbacks under their
  ids and, while the new **Buttons from module 1.x** setting is on (switched
  on by the upgrade only), the 1.x variables `playback_status_<id>`,
  `current_time_<id>`, `frame_index_<id>`, `cue_index_<id>`,
  `clip_index_<id>`, `composition_duration_<id>`, `current_volume_<id>`.
  Unknown reads `?`, never 1.x's `0`.
- **Keys in the Exaplay look.** Every preset wears the outlined square and
  glyph of Produce & Play's transport buttons on the Exaplay page tone; a
  state lights the outline and glyph in its colour (playing green, paused
  amber, stopped red, show mode blue), Blank and Audio mute fill solid red.
  The faces are drawn in code (no image asset). Feedback default colours
  follow the Exaplay palette.
- **In the Exaplay installer:** `deploy.bat` / `nightly_build.bat` build the
  package and the installer puts `vioso-exaplay-<version>.tgz` in
  `integrations\companion\`.
- Needs **Companion 4.2** or later (module API 1.14) — the earlier notes said
  3.x, which was wrong.

## 1.3.0 - 2026-10-08

Still unit-tested only — not yet run inside Companion or against an engine.

- **An installable package.** `npm run package` builds
  `vioso-exaplay-<version>.tgz` with Companion's own tools; Companion 4 imports
  it on its Modules page (*Import module package*) — no Node.js on the
  Companion PC. `npm run check` runs Companion's manifest check. CI builds and
  uploads the package on every run.
- **Ready for Companion's module list:** package name `vioso-exaplay`,
  repository `bitfocus/companion-module-vioso-exaplay`, MIT `LICENSE`.
- Built against `@companion-module/base` 1.14 and the `node22` runtime
  (Companion 4.x).

## 1.2.0 - 2026-10-08

Still unit-tested only — not yet run inside Companion or against an engine.

- **Blank, Audio mute, Identify, the blank fade and Play all go over TCP**
  (Exaplay 3.4: `system.blank=on|off|toggle[,<s>]`, `system.blankfade=`,
  `system.audiomute=`, `system.identify=`, `system.playall`), so a refused
  line is reported instead of vanishing. A new connection setting, *Blank,
  Audio mute, Identify, Play all over*, switches back to OSC for an older
  engine. Outlines and the raw wall stay on OSC.

## 1.1.0 - 2026-10-08

Still unit-tested only — not yet run inside Companion or against an engine.

- **Cue lists.** On connect, after a project load, when the project name or
  the composition list changes, after the status feed comes back, and on the
  *Refresh cue lists and command buttons* action, the module reads
  `get:complist`, each composition's `get:type` and `get:cuelist` (and its
  stored volume / opacity) over TCP — on a background queue that never delays
  an operator command. New: *Cue: go (pick from the cue lists)* dropdown,
  a **Cues: <composition>** preset folder with one GO key per cue, and the
  feedbacks *Cue: is the current cue* / *Cue: is the next cue*.
- **Command buttons.** The project's command buttons are read (read only)
  from `GET /data?type=exaObj&path=project&values` → `control_panel_items`;
  the script itself is never kept. *Command button: press* gets a dropdown (the
  text ID still overrides, so 1.0 buttons keep working), a **Command buttons**
  preset folder, the variable `button_last` and the feedback *Command button:
  its last press failed* with the engine's reason.
- **A running command button lights up.** The status feed's
  `buttons-running` drives the feedback *Command button: its commands are
  running* (amber on every command-button preset, whoever pressed it) and the
  variable `buttons_running`. Unlit while an engine does not report it.
- **Dials (Stream Deck+).** Composition volume and opacity (`set:vol` /
  `set:alpha`, set with *learn*, nudge), engine master volume (`POST /data`
  `path:"global"` `audio-volume`), seek ± seconds and jump to a time
  (`set:time`), Timeline frame jump (OSC `/frame`), and a cue-picker dial
  (turn to pick, press to GO). Every live write goes through a throttle — one
  in flight, the latest value wins, never a debounce — and a nudge needs a
  known base: the dial reads the engine first and drops the turn if the read
  fails. **Dials: …** preset folders with `rotaryActions`.
- **More engine actions:** Spaces page (`system.showpage=`), all projectors
  on/off (`POST /cmd` `pjlink-all`), correction bypass / raw wall and blank fade
  time (OSC), loop on/off/toggle, engine restart (project / clean — sent only
  with the action's confirmation box ticked), Inputs: send to a channel
  (`track,…`), nudge a channel, switch Inputs rule groups (`POST /tracking`),
  free OSC and HTTP to the engine only, *Re-sync*, *Clear last error*.
- **Variables:** per composition `playing`, `duration`, `remaining`
  (+ `_s`, `_hms`, `_mmss`), `time_hms`, `time_mmss`, `progress`,
  `progress_bar`, `next_cue_name`, `next_cue_index`, `cue_count`,
  `selected_cue_*`, `volume`, `opacity`; global `correction_bypass`,
  `master_volume`, `lists_state`, `button_count`, `button_last`. A Timeline's
  remaining time needs the `/status` key `duration`; without it it reads `?`.
- **Feedbacks:** time running out (remaining < N s), a progress colour
  (advanced), correction bypass, connection lost (flashing), cue picked.
- Compositions only the TCP list knows (status feed off) get dropdown entries,
  variables and presets too.

## 1.0.0 - 2026-10-08

- Initial Bitfocus Companion module (Companion 3.x, `@companion-module/base`
  1.10, CommonJS, Node 18+).
- One persistent TCP connection for transport, cues, next/previous, Show mode
  and raw commands, with reconnect backoff (1 s doubling to 30 s), a `hello`
  keepalive, and a `hello`/`hallo` re-sync after a command that got no reply.
  Nothing is ever resent.
- Live status from the engine's `/status` WebSocket (protocol v1): variables,
  boolean feedbacks, composition dropdowns and per-composition presets.
  Reconnects after 15 s of silence; every value reads unknown while the feed
  is down.
- Command buttons pressed by id over `POST /control/fire`; Stop all over
  `POST /stop`; Blank (with optional fade), Audio mute, Identify, Outlines and
  Play all over OSC.
- `node --test` suite: pure command/reply/status/format modules, plus the TCP
  client, status client and HTTP requests against local mock servers.
