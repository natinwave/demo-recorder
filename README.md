# demo-recorder

Replays a JSON "browse plan" in a real Chrome window, records the screen while it
runs, logs a timestamped moment for every step, then cuts the recording down for
brevity. `cut.mjs` also works on its own as a basic cutter for any video.

Everything runs locally: Node, Google Chrome, ffmpeg. No accounts or services.

## Setup (macOS)

    brew install ffmpeg
    cd ~/demo-recorder && npm install
    node record.mjs --selftest

The first recording makes macOS ask for **Screen Recording** permission for the
app that ran the command (Terminal, iTerm, VS Code, ...). Grant it in System
Settings > Privacy & Security > Screen & System Audio Recording, restart that
app, and run the self-test again. The self-test passes when it prints
`"ok": true`; open `demo-videos/selftest/selftest.mp4` to see the result.

## Use it from Claude Code (optional)

`skill/record-feature-demo/SKILL.md` is a skill that teaches Claude Code to write
plans, record and cut demos with this tool. To install it for yourself:

    mkdir -p ~/.claude/skills/record-feature-demo
    cp skill/record-feature-demo/SKILL.md ~/.claude/skills/record-feature-demo/

The skill looks for the tool in `$DEMO_RECORDER_HOME`, then `~/demo-recorder`.
If you cloned it somewhere else, either link it there
(`ln -s "$PWD" ~/demo-recorder`) or export `DEMO_RECORDER_HOME` in your shell
profile.

## Record a feature demo

    node ~/demo-recorder/record.mjs demo-videos/coupon.plan.json

Output goes to `demo-videos/<plan name>/`:

| File | What it is |
|---|---|
| `<name>.mp4` | The finished, trimmed video |
| `raw.mp4` | The untouched full-screen recording |
| `moments.json` | Every step with its start/end time in `raw.mp4`, plus the window position |
| `edit.json` | The edit list that produced the trimmed video; edit it and re-render |
| `segments.csv` | The same cuts for LosslessCut (File > Import project > CSV) |
| `failure.png` | Screenshot of the page, only if a step failed |

Options: `--frame window` (default: crop to the whole Chrome window, tabs and
address bar included) or `--frame screen` (the entire display), `--out <dir>`,
`--check` (validate the plan only), `--no-cut`, `--keep-open`, `--signin`
(see below).

The raw recording is always the full display, so you can switch framing later
without re-recording:

    node ~/demo-recorder/cut.mjs --moments demo-videos/coupon/moments.json --frame screen

Exit codes: `0` ok, `1` setup or plan problem, `2` a step failed (the video up
to the failure is still produced), `3` Chrome was not visible in the recording.

## Plan format

    {
      "name": "Coupon checkout",
      "baseUrl": "http://localhost:3000",
      "steps": [
        { "do": "title", "eyebrow": "Shopper", "title": "Apply a coupon at checkout",
          "points": ["Open the cart", "Enter a coupon code", "See the discount applied"] },
        { "do": "goto", "url": "/cart", "moment": "Open the cart" },
        { "do": "type", "target": "#code", "text": "SAVE10", "moment": "Enter a coupon code" },
        { "do": "click", "target": "role=button[name='Apply coupon']" },
        { "do": "expect", "target": "#message", "text": "Coupon applied", "moment": "The discount is applied" }
      ]
    }

Plan-level keys (all optional except `steps`): `name`, `baseUrl`, `frame`
(`window` | `screen`), `window` (`{width, height}`, default 1440x900),
`captions` (default true: show each moment label on the page), `timeout`
(seconds per step, default 15), `readingSpeed` (words per minute used to time
captions, highlights and title cards, default 180; lower it for a slower video),
`momentHold` (minimum seconds to linger after a labeled step, default 2; longer
captions get their reading time), `pace` (pause after every step, default 0.3),
`tail` (seconds kept after the last step, default 1), `profile` (name of a
persistent Chrome profile, to stay signed in between recordings), `signinUrls`
(pages `--signin` opens, default `baseUrl`), `storageState` (Playwright
storage-state file), `browser` (Playwright channel, default `chrome`).

Step keys: `do` plus the fields below; `target` is a Playwright selector
(`#id`, `text=Save`, `role=button[name='Save']`, ...). Any step may add
`moment` (a label: marks it as worth watching), `edit`, `hold` (seconds to
linger afterwards) and `timeout`.

| `do` | Fields | Notes |
|---|---|---|
| `goto` | `url` | Relative to `baseUrl` |
| `click` | `target`, `double`, `button` | |
| `hover` | `target` | |
| `fill` | `target`, `text` | Sets the value at once |
| `type` | `text`, `target`, `delay` | Types key by key |
| `press` | `key`, `target` | e.g. `Enter`, `Control+K` |
| `select` | `target`, `value` | |
| `check` / `uncheck` | `target` | |
| `upload` | `target`, `files` | Paths relative to the plan file |
| `scroll` | `target` or `to` (`top`/`bottom`) or `by` (pixels) | Smooth scroll |
| `waitFor` | `target`, `state` | `visible` (default), `hidden`, `attached`, `detached` |
| `waitForUrl` | `url` | String, glob or regex source |
| `expect` | `target`, `text` | Fails the recording if the text never appears |
| `wait` | `seconds` | |
| `highlight` | `target`, `seconds` | Draws a ring around the element; without `seconds`, holds long enough to read its text (2-7 s) |
| `title` | `title`, `subtitle`, `points`, `eyebrow`, `seconds` | Full-frame title card between sections (see below) |
| `eval` | `js` | Runs JavaScript in the page |
| `switchTab` | `url` or `which` | Default: the tab that just opened |

## Title cards and reading time

A `title` step shows a full-frame card: an optional `eyebrow` (small caps, e.g.
"Part 2 of 4 · Admin"), the `title`, an optional `subtitle` and up to a few
`points` summarising what comes next. Use one at the start, and one whenever
the demo changes perspective (customer, admin, partner...), so viewers always
know whose screen they are looking at.

The card is drawn in the page and captured as a still image; the cutter then
shows that still for `seconds` (default: reading time at `readingSpeed`, 3-12 s),
scaled to fill the frame with no tabs or address bar. It costs no recording
time and gets its own chapter marker. The stills are saved as `title-NN.png`
next to the video.

Reading time is spent only where it pays off: labeled steps (`moment`) hold for
their caption, `highlight` holds for the text inside the ring, title cards for
their text. Unlabeled steps such as filling fields stay quick.

How the cut is decided (`edit` on a step overrides it):

- `"edit": "cut"` drops the step (logins, setup). `"keep"` leaves it untouched.
  `"fast"` fast-forwards it.
- Otherwise, stretches where nothing on screen changes for more than 1.5 s
  (waiting on a server or a build) are jump-cut down to about a second, except
  while a labeled moment is being held on screen.
- Unlabeled steps that still run longer than 1.5 s are sped up.
- Everything before the first step is dropped.

## Cutting any video

    node cut.mjs talk.mp4 --keep "0:05-0:20,1:10-1:30"       keep only these parts
    node cut.mjs talk.mp4 --remove "0:20-1:10"                drop a part
    node cut.mjs talk.mp4 --keep "0:00-0:10,0:10-2:00@4x"     fast-forward a part
    node cut.mjs --edl edit.json                              render an edit list

Add `--csv` to also write the segments for LosslessCut, `--out <file>` to name
the result, `--max-width 1280` to scale down. Cuts are frame-accurate
(re-encoded) and sound is kept.

An edit list is:

    {
      "source": "raw.mp4",
      "crop": { "x": 0, "y": 76, "w": 2880, "h": 1800 },
      "output": { "maxWidth": 1920, "crf": 20 },
      "segments": [
        { "start": 3.2, "end": 9.5, "label": "Open the cart" },
        { "start": 14.0, "end": 31.0, "speed": 8 }
      ]
    }

Segments are the parts that are kept, in playback order; `crop` and `output`
are optional. Labels become chapter markers in the output.

## Things to know

- Automated clicks do not move the real mouse pointer, so the recorder draws its
  own cursor, click ripples and captions inside the page. The real pointer is
  left out of the recording.
- Do not use the mouse or keyboard, or cover the Chrome window, while a
  recording runs.
- Chrome opens with a fresh profile, so nothing is signed in. Use `"profile"`
  or sign in with steps marked `"edit": "cut"`.
- To sign in to a profile by hand, run `node record.mjs plan.json --signin`. It
  opens the plan's profile with the same settings a recording uses, at
  `signinUrls` (or `baseUrl`); sign in, then close the window. Signing in with an
  ordinary Chrome window does not work: the recorder's Chrome cannot read
  cookies that ordinary Chrome saved.
- Sites behind an HTTP basic-auth prompt: Chrome cancels the prompt under
  automation. Set `DEMO_HTTP_USER` and `DEMO_HTTP_PASSWORD` (optionally
  `DEMO_HTTP_ORIGIN` to send them to one site only) in the environment; they are
  never read from the plan. During `--signin` you can instead type
  `https://user:password@host/` in the address bar.
- macOS: the main display is recorded. Set `DEMO_SCREEN=1` for another display.
- A new browser *window* (not a tab) falls outside the window crop; the recorder
  warns when that happens. Use `--frame screen`.
- Linux needs an X display (`DISPLAY`); Windows is not supported yet.
