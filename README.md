# Zen Session

A calm focus timer for Windows. Three things it does that most don't:

- **Minimizes to a floating glass pill** that stays above everything else, shows the
  countdown, and optionally shows what you're listening to.
- **A weekly timetable** with days down the left and hours across the top, where what you
  *planned* and what you *actually completed* share one grid.
- **Five themes**, none of them purple.
- **Calm background sounds** in their own section — rain, waves, nature and a fireplace,
  bundled as seamless loops and playing on whether you press play, not on what the timer
  is doing.

## Running it

```
npm install
npm start
```

## Building an installer

```
npm run build          # -> dist/Zen Session Setup 1.5.0.exe
npm run icons          # regenerates resources/icon.ico + tray.ico from the brand SVGs
npm run sounds         # rebuilds resources/sounds/*.ogg from their sources (needs network)
```

## Tests

```
node scripts/test-timer.js
```

Covers the timer core outside Electron: countdown accuracy against the wall clock,
pause/resume, the focus → short break → focus → long break cycle, session logging, and
that skipping does not log a session.

## How it's put together

```
src/main/
  index.js        app lifecycle, windows, tray, global shortcuts
  timer-core.js   the single source of truth for the timer
  pill-window.js  the floating always-on-top pill window
  media.js        now-playing bridge (read-only)
  store.js        JSON persistence in %APPDATA%/Zen Session
  ipc.js          every channel between main and the renderers
  week.js         week-key and day-index helpers
src/preload/      contextBridge surface; the renderers get no Node access
src/renderer/
  index.html      main window — timer, timetable, settings
  pill.html       the pill
  styles/         tokens.css is the ONLY file with literal colours
  js/             springs.js, app.js, timetable.js, pill.js
  assets/         brand SVGs used inside the UI
resources/
  smtc.ps1        the now-playing reader
  brand/          the source brand SVGs
  icon.ico        app + installer icon (16/24/32/48/64/128/256)
  tray.ico        tray icon (16/20/24/32)
scripts/
  make-icons.js   rasterises the brand SVGs into the .ico files
  test-timer.js
```

### The timer lives in the main process

`timer-core.js` runs in main, not in a renderer, and derives remaining time from a
wall-clock deadline (`endsAt - Date.now()`) rather than accumulating interval callbacks.
Both windows render the same state, so a hidden or throttled renderer can't desync it and
the countdown can't drift.

### Colour

`src/renderer/styles/tokens.css` is the only file allowed to contain a literal colour.
Everything else uses `var(--focus)`, `var(--break)`, `var(--accent)` and so on. Switching
theme sets `documentElement.dataset.theme`; switching mode sets `data-mode`, which
repoints `--accent`. A literal hex anywhere outside `tokens.css` is a bug.

| Theme | Focus | Break | Ground |
| --- | --- | --- | --- |
| Forest (default) | `#2FA36B` | `#FF6F5E` | `#0C1210` |
| Amber | `#E8A33D` | `#35B9A6` | `#121008` |
| Slate | `#3B82C4` | `#E0A458` | `#0B0F14` |
| Graphite | `#A3E635` | `#5A6B48` | `#101211` |
| Midnight | `#FFFFFF` | `#FFB454` | `#000000` |

### Motion

`springs.js` implements springs in Apple's two parameters — damping ratio and response —
rather than mass/stiffness/friction. Every spring retargets from its current value and
keeps its velocity, so motion is interruptible rather than jumping on re-trigger.

| Moment | damping / response |
| --- | --- |
| Start, pause, ring glow | 1.0 / 0.35 |
| Session complete (overshoot) | 0.8 / 0.40 |
| Media row arriving on the pill | 0.8 / 0.30 |
| Press feedback | `scale(.97)`, 100ms, on **pointerdown** |

The ring sweep itself is linear off the clock — only discrete events spring. Dragging a
timetable block uses pointer capture with a 10px commit threshold, and the release uses
momentum projection (`x + (v/1000)·d/(1−d)`, `d = 0.998`) before snapping to the nearest
quarter hour, so a flick lands where the gesture was heading.

`prefers-reduced-motion`, `prefers-reduced-transparency` and `prefers-contrast` are all
honoured, which on Windows means the app follows the system animation and transparency
settings.

### Now playing

`resources/smtc.ps1` reads Windows' System Media Transport Controls — the same source as
the volume-key overlay, so it covers Spotify, browsers, VLC and others. It runs as a
single long-lived PowerShell process printing one JSON line every two seconds; there is no
native module and nothing to compile.

It is **read-only**: the app never sends play/pause/next back to the player, so the pill's
one button is unambiguously the *timer's*.

It is also entirely optional. If PowerShell is unavailable, WinRT isn't reachable, or the
script dies, `media.js` reports "nothing playing" forever, the pill stays at 240×56, and
the timer is unaffected.

### Sounds

All four are real field recordings, bundled as 40-second loops in
`resources/sounds/` — no streaming, no download at runtime, and they keep playing while
the window is hidden behind the pill. Behind each one is also a synthesised bed in
`src/renderer/js/ambience.js`, which only plays if a loop is missing or will not decode,
so the section always works.

`scripts/fetch-sounds.js` builds the loops and is the only place their provenance lives.
It downloads each source from Wikimedia Commons, cuts a window that was picked by
measuring the recording rather than by ear — level spread, spectral flatness, and no
tonal frames, which is how birdsong and voices give themselves away — matches every
sound to −20 LUFS so switching one for another does not jump, and then makes the clip
circular: the last three seconds are equal-power crossfaded into the first three, so the
sample after the end is the sample that followed it in the original. That is why the
files can loop forever with nothing to hear at the seam.

Rain is the one chosen against a stricter brief, because it is the one most people leave
running while they work: of every rain recording measured, its window varies by 0.8 dB
across the whole 40 seconds and contains no quarter-second that jumps above its
neighbours — no drips, no gusts, nothing that pulls attention back out of a page. It also
takes a −3.5 dB shelf above 5 kHz, since the brightness is what makes a rain bed tiring
by the second hour.

The recordings are read by the main process and handed to the renderer over IPC, because
Chromium will not `fetch()` a `file://` URL whatever the CSP says.

The audio context is pinned to 48 kHz rather than taking the device rate, because
`decodeAudioData` resamples to whatever the context runs at: on a 192 kHz interface the
same 40-second loop would decode to 60 MB instead of 15. At most two decoded buffers are
held at a time.

Each loop keeps the licence of the recording it came from — public domain, CC0,
CC BY 4.0 and CC BY-SA 4.0 — which are separate from the MIT licence on the rest of the app. The player shows
the credit for whatever is selected, and `resources/sounds/CREDITS.md` has the full list.

## Keyboard

| Key | Does |
| --- | --- |
| `Space` | Start / pause (when the window has focus) |
| `1` `2` `3` `4` | Timer / Timetable / Sounds / Settings |
| `Ctrl+Alt+P` | Start / pause from anywhere in Windows |
| `Ctrl+Alt+O` | Show or hide the window from anywhere |

## Using the timetable

Drag across a day row to block out time. Blocks snap to 15 minutes. Double-click a block's
label to rename it, hover it for the remove button. Completed focus sessions fill in over
whatever you planned; a session with nothing planned behind it gets drawn on its own.

## Known limitations

- **The pill's glass does not blur the desktop behind it.** A transparent Electron window
  can only blur content within its own page — `backdrop-filter` has nothing to sample — so
  the pill uses a dense surface with a lit top edge and an inner rim instead. Real desktop
  blur would need `backgroundMaterial: 'acrylic'`, which on Windows forces square corners:
  a worse trade for a pill.
- **The pill window is 24px larger than the pill on every side.** That margin is
  transparent and exists so the pill's soft rounded shadow has somewhere to fall. Sized to
  the pill exactly, the shadow is clipped away entirely and the only thing left is the
  square shadow Windows draws around the window. Because a transparent window still
  swallows clicks, `startCursorWatch` in `pill-window.js` polls the cursor and toggles
  `setIgnoreMouseEvents`, so the margin is click-through and only the pill itself is
  interactive.
- **The pill resizes in one step**, not on a spring. The window bounds change immediately
  when media starts or stops; the media row's contents then spring in. Animating the window
  bounds at 60fps was possible but looked worse than the jump.
- Closing the main window drops to the pill rather than quitting. Quit from the tray menu
  or the link at the bottom of Settings.
- The installer is unsigned, so Windows SmartScreen will warn on first run.

## Brand assets

`resources/brand/` holds the source SVGs. `npm run icons` rasterises them into
`resources/icon.ico` and `resources/tray.ico` — it runs under Electron so Chromium does
the SVG rendering and there is no image library to install.

Which artwork is used at which size follows the set's own logic: **16 and 24px use
`zen-session-favicon-16.svg`** (extra bold, no inner dot, larger gap dot), **32px and up
use `zen-session-app-icon.svg`**. Below about 24px the thin sage arc and the white centre
dot turn to mush, which is exactly why the simplified artwork exists.

Two variants are derived rather than shipped in the original set, because the app's UI is
dark and every supplied mark either has an opaque plate or is dark ink meant for light
backgrounds:

| Derived file | From | Change |
| --- | --- | --- |
| `src/renderer/assets/zen-mark-on-dark.svg` | `zen-session-icon-32.svg` | ink recoloured to cream, tile removed |
| `src/renderer/assets/zen-logo-horizontal-on-dark.svg` | `zen-session-logo-horizontal-on-black.svg` | black plate removed |

The rail mark and the About lockup use those. They stay brand-cream rather than following
`--accent`, because a logo that changes colour with the theme stops being a logo.

## Credits

Space Grotesk by Florian Karsten, SIL Open Font License 1.1 — bundled in
`src/renderer/fonts/`, see `OFL.txt` there.

The background sounds are excerpts from freely licensed recordings on Wikimedia Commons:
*Calm rain* by Zuvji (CC BY-SA 4.0), *Ocean Waves on a Tropical Beach*
by Jarrod Stanley (CC0), *Bourne woods, windy* by Robert EA Harvey (CC BY-SA 4.0), and
*Bonfire burning* by Work With Sounds / Werstas (CC BY 4.0). Full details, including the
licence links and what was done to each one, are in `resources/sounds/CREDITS.md`.
