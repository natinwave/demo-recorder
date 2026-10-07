---
name: "record-feature-demo"
description: "Record a trimmed screen-recording demo of a web feature once it is finished, or make basic cuts to any video file, using the local demo-recorder tool."
---

# Record a feature demo

Use this after finishing a feature that can be seen in a browser, when the user asks for a demo, walkthrough or recording, or when they ask for basic cuts to a video file (remove a section, keep only some ranges, speed a part up).

The tool is the demo-recorder repo (https://github.com/natinwave/demo-recorder). Find it at `$DEMO_RECORDER_HOME` if set, otherwise `~/demo-recorder`; if neither has `record.mjs`, ask the user where they cloned it, and if it is not installed, stop and say so rather than rebuilding it. Below, `$DR` stands for that folder. If `$DR/node_modules` is missing, run `npm install` there. ffmpeg comes from `brew install ffmpeg`.

It replays a JSON browse plan in a real Chrome window, records the screen with ffmpeg, logs a timestamped moment per step, and cuts the recording: dead time is removed, title cards and labeled moments are held long enough to read.

## Workflow

1. Make sure the thing to record is running and reachable, with the data the demo needs. Check for leftovers from earlier runs (records with the same test email, files already uploaded); they show up on camera as duplicate rows.
2. Write the plan to `demo-videos/<short-name>.plan.json` in the project. Base selectors on the code you just wrote and on the markup the page really renders, not on guesses.
3. Validate it: `node $DR/record.mjs demo-videos/<short-name>.plan.json --check`
4. If the plan uses a `profile` that is not signed in yet, set up sign-ins first (see Signing in).
5. Record: `node $DR/record.mjs demo-videos/<short-name>.plan.json`
   This takes over the screen for the length of the plan plus about 15 seconds; title cards add no recording time. Allow a generous command timeout. Tell the user beforehand not to touch the mouse or keyboard or cover the Chrome window, and tell them about any step that needs them (see Steps only a person can do).
6. Read the JSON summary printed at the end and act on the exit code (below).
7. Check the result before reporting: list the chapters (`ffprobe -v error -show_chapters -of json <video>`) and look at a few frames (`ffmpeg -ss <t> -i <video> -frames:v 1 frame.jpg`) at the key moments.
8. Report the path of the finished video (`video` in the summary), its length, the chapter list and any warnings. Do not commit anything under `demo-videos/` unless asked. Delete any test data the demo created, if the user asked for that.

## Exit codes

- `0` The video is ready.
- `1` Setup or plan problem; the message says what. On macOS a capture failure usually means the app running the command lacks Screen Recording permission (System Settings > Privacy & Security > Screen & System Audio Recording, then restart that app). The user has to grant this; you cannot. "The profile is already open" means a Chrome window using that profile is still running; ask the user to close it.
- `2` A step failed. `failure` in the summary names the step and error, and `failure.png` in the output folder shows the page at that point. Read the screenshot, fix the plan (or the feature, if the demo found a real bug) and record again. A failed `expect` means the feature did not do what the plan claims: say so plainly instead of weakening the check. A `net::ERR_INVALID_AUTH_CREDENTIALS` on a `goto` means the site wants HTTP basic auth (see Signing in).
- `3` Chrome was not visible in the recording (covered by another window, on a different display, or no Screen Recording permission). The video is not usable. Pass the warning text on to the user.

If the summary has a warning that a separate browser window opened, re-cut without re-recording: `node $DR/cut.mjs --moments demo-videos/<name>/moments.json --frame screen`

## Structure the demo for a viewer

- Start with a `title` card that says what the demo shows, in a sentence and three or so points.
- Whenever the perspective changes (customer, staff/admin, partner, a second user), add a `title` card with an `eyebrow` like "Part 2 of 5 · Admin", a `title` naming what happens in that part, and `points` listing what the viewer is about to see. Viewers should never have to guess whose screen they are looking at.
- Spend reading time on what matters, not on typing: `highlight` the sentence, message or element that proves the point (without `seconds`, it holds for the reading time of the text inside it), and give those steps a `moment`. Leave form filling unlabeled so it stays quick.
- End on an `expect` with a `moment`, so the video finishes on visible proof that the feature works.
- `readingSpeed` (words per minute, default 180) sets the pace for captions, highlights and cards. Lower it for a slower video.

## Framing

Default is `--frame window`: the whole Chrome window, including tabs and the address bar. Use `--frame screen` for the entire display when something outside that window matters (popup windows, native file pickers, another app). The raw recording is always the full display, so framing can be changed later with `cut.mjs --moments ... --frame screen|window`. Title cards always fill the frame.

## Plan format

```json
{
  "name": "Coupon checkout",
  "baseUrl": "http://localhost:3000",
  "steps": [
    { "do": "title", "eyebrow": "Shopper", "title": "Apply a coupon at checkout",
      "points": ["Open the cart", "Enter a coupon code", "See the discount applied"] },
    { "do": "goto", "url": "/login", "edit": "cut" },
    { "do": "fill", "target": "#email", "text": "demo@example.com", "edit": "cut" },
    { "do": "click", "target": "role=button[name='Sign in']", "edit": "cut" },
    { "do": "goto", "url": "/cart", "moment": "Open the cart" },
    { "do": "type", "target": "#code", "text": "SAVE10", "moment": "Enter a coupon code" },
    { "do": "click", "target": "role=button[name='Apply coupon']" },
    { "do": "expect", "target": "#message", "text": "Coupon applied" },
    { "do": "highlight", "target": "#total", "moment": "The discount is applied" }
  ]
}
```

Plan keys, all optional except `steps`: `name`, `baseUrl`, `frame` (`window` or `screen`), `window` (`{width, height}`, default 1440x900), `captions` (default true), `timeout` (seconds per step, default 15), `readingSpeed` (words per minute, default 180), `momentHold` (minimum seconds after a labeled step, default 2), `pace` (default 0.3), `tail` (default 1), `profile` (name of a persistent Chrome profile that keeps sign-ins between recordings), `signinUrls` (pages `--signin` opens), `storageState`, `browser`.

Every step has `do` and may have `moment`, `edit`, `hold` (seconds to linger afterwards) and `timeout`. `target` is a Playwright selector: `#id`, `text=Save`, `role=button[name='Save']`, `[data-testid=x]`. Prefer `text=` for prose (help text, notices) whose element and id depend on how the page is rendered.

| do | fields |
|---|---|
| title | title, subtitle, points, eyebrow, seconds (full-frame card; default: reading time, 3-12 s) |
| goto | url |
| click | target, double, button |
| hover | target |
| fill | target, text (sets the value at once) |
| type | text, target, delay (types key by key; looks better on video) |
| press | key, target |
| select | target, value |
| check, uncheck | target |
| upload | target, files (paths relative to the plan file) |
| scroll | target, or to (top or bottom), or by (pixels) |
| waitFor | target, state |
| waitForUrl | url |
| expect | target, text (fails the recording if the text never appears) |
| wait | seconds |
| highlight | target, seconds (ring around the element; default: time to read its text, 2-7 s) |
| eval | js (an expression; a returned promise is awaited) |
| switchTab | url or which (default: the tab that just opened) |

## Writing a plan that cuts well

- `moment` is a short caption in plain words ("The discount is applied"). It is shown on screen, becomes a chapter marker, holds long enough to read, and tells the cutter this step is worth watching at normal speed. Label the steps a viewer should notice, not every step.
- Mark logins, seeding and navigation to the starting point with `"edit": "cut"`. Put a section's `title` card after its cut setup steps, so the card leads straight into what it introduces.
- Do not add `wait` steps to cover slow loads. Use `waitFor` or `expect`; stretches where nothing on screen changes are removed automatically, and unlabeled steps that still run long are sped up.
- Use `"edit": "keep"` on a step whose waiting is itself the point (a progress bar, an animation). Use `"edit": "fast"` to fast-forward something long but relevant.
- Values created during the recording (a new record's id, a one-time link) can be reached with an `eval` that reads them from the page and navigates, e.g. `setTimeout(() => { location.href = document.querySelector('#link').value }, 50)`, followed by `waitForUrl`. Mark both `"edit": "cut"`.

## Signing in

Chrome starts with a fresh profile, so nothing is signed in. Either sign in with cut steps (test accounts only), or give the plan a `profile` and have the user sign in to it once:

```
node $DR/record.mjs demo-videos/<short-name>.plan.json --signin
```

This opens the profile with exactly the settings recordings use, at `signinUrls` (or `baseUrl`). The user signs in and closes the window. Do not type passwords into it yourself. A profile signed in from an ordinary Chrome window does not work: the recorder's Chrome cannot read cookies that ordinary Chrome saved.

Sites behind an HTTP basic-auth prompt: Chrome cancels the prompt under automation. The user can put the login in the address bar during `--signin` (`https://user:password@host/`), or set `DEMO_HTTP_USER` and `DEMO_HTTP_PASSWORD` (optionally `DEMO_HTTP_ORIGIN`) in the environment. Never write these into a plan file.

## Steps only a person can do

Some things must not be automated, such as a CAPTCHA. Let the person do it during the recording: add an `eval` step marked `"edit": "cut"` that waits for the result, then continue. For reCAPTCHA:

```json
{ "do": "eval", "edit": "cut",
  "js": "new Promise((resolve, reject) => { const t0 = Date.now(); const timer = setInterval(() => { if (document.querySelector('[name=g-recaptcha-response]')?.value) { clearInterval(timer); resolve(); } else if (Date.now() - t0 > 170000) { clearInterval(timer); reject(new Error('reCAPTCHA was not ticked')); } }, 300); })" }
```

Tell the user before recording that they will need to tick it when the page pauses, and to touch nothing else. Give that step a long enough `timeout`. Have the plan click the submit button itself, right after.

## Output

Everything lands in `demo-videos/<plan name>/`: `<name>.mp4` (the finished video, with chapters), `raw.mp4` (untouched full-screen recording), `moments.json` (each step's start and end time in the raw video), `edit.json` (the edit list that produced the finished video), `segments.csv` (the footage cuts for LosslessCut, via File > Import project > CSV), `title-NN.png` (title card stills).

To change the cut without re-recording, edit `segments` in `edit.json` and run `node $DR/cut.mjs --edl demo-videos/<name>/edit.json --out <file>`. Footage segments are `{start, end, speed, label}` in seconds of `raw.mp4`; title cards are `{image, duration, label}` (change `duration` to hold a card longer). Segments play in the order listed. Running `cut.mjs --moments` again regenerates `edit.json` and overwrites hand edits.

## Cutting any video

`cut.mjs` works on any video file, with sound:

```
node $DR/cut.mjs talk.mp4 --keep "0:05-0:20,1:10-1:30"
node $DR/cut.mjs talk.mp4 --remove "0:20-1:10"
node $DR/cut.mjs talk.mp4 --keep "0:00-0:10,0:10-end@4x"
node $DR/cut.mjs --edl edit.json --out final.mp4
```

Times are seconds, `m:ss` or `h:mm:ss`; `end` means the end of the file; `@4x` sets speed. Add `--out <file>`, `--max-width 1280`, or `--csv` to also write the segments for LosslessCut. The source file is never modified; the default output is `<name>.cut.mp4` beside it. Check the printed `duration` against what the user asked for before reporting.
