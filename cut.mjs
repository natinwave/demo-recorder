#!/usr/bin/env node
// Cut a video down to a list of kept segments (optionally sped up, cropped, scaled).
//
//   node cut.mjs --moments demo-videos/x/moments.json        recording -> trimmed demo
//   node cut.mjs --edl edit.json                             render a hand-edited edit list
//   node cut.mjs talk.mp4 --keep "0:05-0:20,1:10-1:30@2x"    keep only these ranges
//   node cut.mjs talk.mp4 --remove "0:20-1:10"               drop these ranges, keep the rest
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { run, parseArgs, parseTime, fmtTime, round3, even, probe, hasEncoder } from './lib/util.mjs';

const USAGE = `Usage:
  node cut.mjs --moments <moments.json> [options]   Build edit.json from a recording's moments and render it
  node cut.mjs --edl <edit.json> [options]          Render an edit list
  node cut.mjs <video> --keep "<ranges>"            Keep only these ranges
  node cut.mjs <video> --remove "<ranges>"          Remove these ranges

Ranges: comma-separated start-end, each optionally followed by @<speed>x.
        Times are seconds, m:ss or h:mm:ss. "end" means the end of the video.
        Example: "0:05-0:20,1:10-end@2x"

Options:
  --out <file>         Output file (default: next to the source)
  --frame <mode>       window | screen (moments only; default: what was recorded)
  --max-width <px>     Scale down to at most this width (default 1920)
  --max-idle <sec>     Unlabeled steps longer than this get sped up (default 1.5)
  --max-speed <n>      Fastest speed-up allowed (default 16)
  --crf <n>            x264 quality, lower is better (default 20)
  --keep-stills        Do not jump-cut stretches where nothing on screen changes
  --plan-only          Write edit.json / CSV but do not render
  --csv                Also write a LosslessCut segments CSV`;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function subtract(intervals, holes) {
  let out = intervals;
  for (const [h0, h1] of holes) {
    const next = [];
    for (const [a, b] of out) {
      if (h1 <= a || h0 >= b) { next.push([a, b]); continue; }
      if (h0 > a) next.push([a, h0]);
      if (h1 < b) next.push([h1, b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a > 0.04);
}

/**
 * Find stretches where the picture does not change (waiting on a server, a
 * build, a slow page). Returns [{start, end}] in seconds. A blinking text
 * caret or a tab spinner is below the noise floor; a moving cursor is not.
 */
export async function detectStills(video, crop, { minDuration = 1.5, noise = 0.00015 } = {}) {
  const chain = [];
  if (crop) chain.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  chain.push(`freezedetect=n=${noise}:d=${minDuration}`);
  const r = await run('ffmpeg', ['-hide_banner', '-i', video, '-vf', chain.join(','), '-map', '0:v', '-f', 'null', '-']);
  if (r.code !== 0) return [];
  const stills = [];
  let open = null;
  for (const m of r.stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') open = Number(m[2]);
    else if (open != null) { stills.push({ start: open, end: Number(m[2]) }); open = null; }
  }
  if (open != null) stills.push({ start: open, end: Infinity });
  return stills;
}

/**
 * Turn a recording's moments into an edit list.
 *  - Steps marked edit:"cut" are dropped; edit:"keep" stay untouched.
 *  - Still stretches (opts.stills) longer than maxIdle are jump-cut down to
 *    about a second, except while a labeled moment is being held on screen.
 *  - Unlabeled steps that still run longer than maxIdle are sped up.
 */
export function planEdit(doc, opts = {}) {
  const maxIdle = Number(opts.maxIdle ?? 1.5);
  const maxSpeed = Number(opts.maxSpeed ?? 16);
  const lead = 0.25;
  const frame = opts.frame ?? doc.frame ?? 'window';

  const steps = [];
  let cursor = null;
  for (const m of doc.moments) {
    const from = cursor ?? Math.max(doc.planStart ?? 0, m.start - lead);
    const to = Math.min(m.end, doc.duration);
    cursor = Math.max(to, from);
    steps.push({ m, from, to, mode: m.edit ?? 'auto' });
  }
  const tailEnd = cursor == null ? 0 : Math.min(doc.duration, cursor + Number(doc.tail ?? 1));

  // Time the viewer is meant to sit and look: never trimmed.
  const held = [[cursor ?? 0, doc.duration]];
  for (const { m, from, to, mode } of steps) {
    if (mode === 'keep' || m.do === 'highlight' || (m.do === 'wait' && m.label)) held.push([from, to]);
    else if (m.label && m.settled != null) held.push([Math.max(from, m.settled), to]);
  }
  const dead = subtract(
    (opts.stills ?? [])
      .map((s) => ({ start: s.start, end: Math.min(s.end, doc.duration) }))
      .filter((s) => s.end - s.start > maxIdle)
      .map((s) => [s.start + 0.6, s.end - 0.4]),
    held,
  );

  const segments = [];
  const chapters = [];
  let trimmed = 0;
  const push = (start, end, speed, label) => {
    const prev = segments[segments.length - 1];
    if (prev && !prev.image && prev.speed === 1 && speed === 1 && Math.abs(prev.end - start) < 0.02) {
      prev.end = round3(end);
      if (!prev.label && label) prev.label = label;
    } else {
      segments.push({ start: round3(start), end: round3(end), speed, label: label ?? '' });
    }
  };

  for (const { m, from, to, mode } of steps) {
    if (mode === 'cut') continue;
    // Title cards: a still image held for its reading time replaces the footage of drawing it.
    if (m.do === 'title' && m.image) {
      trimmed += to - from;
      chapters.push({ segment: segments.length, label: m.label });
      segments.push({ image: m.image, duration: Number(m.seconds ?? 4), label: m.label ?? '' });
      continue;
    }
    if (to - from < 0.04) continue;
    const pieces = mode === 'keep' ? [[from, to]] : subtract([[from, to]], dead);
    if (!pieces.length) continue;
    const remaining = pieces.reduce((sum, [a, b]) => sum + (b - a), 0);
    trimmed += to - from - remaining;
    let speed = 1;
    if (mode === 'fast') speed = clamp(remaining / 1.0, 2, maxSpeed);
    else if (mode === 'auto' && !m.label && m.do !== 'highlight' && remaining > maxIdle) speed = clamp(remaining / maxIdle, 1, maxSpeed);
    speed = Math.round(speed * 100) / 100;
    if (m.label) chapters.push({ at: round3(pieces[0][0]), label: m.label });
    pieces.forEach(([a, b], k) => push(a, b, speed, k === 0 ? m.label ?? (speed > 1 ? `(${m.do}, sped up)` : '') : speed > 1 ? `(${m.do}, sped up)` : ''));
  }
  // A short beat after the last step so the final state is readable.
  if (cursor != null && tailEnd - cursor > 0.04) push(cursor, tailEnd, 1, '');

  return {
    version: 1,
    source: doc.video,
    crop: frame === 'window' ? doc.crop ?? null : null,
    output: { maxWidth: Number(opts.maxWidth ?? 1920), fps: 30, crf: Number(opts.crf ?? 20) },
    stillSecondsRemoved: round3(trimmed),
    segments,
    chapters,
  };
}

export function parseRanges(text, duration) {
  return String(text).split(',').map((part) => {
    const m = part.trim().match(/^(.+?)-(.+?)(?:@([\d.]+)x?)?$/);
    if (!m) throw new Error(`Cannot read range "${part}". Expected start-end, e.g. 0:05-0:20`);
    const start = parseTime(m[1]);
    const end = m[2].trim() === 'end' ? duration : parseTime(m[2]);
    if (!(end > start)) throw new Error(`Range "${part}" ends before it starts.`);
    return { start, end, speed: m[3] ? Number(m[3]) : 1, label: '' };
  });
}

function complement(ranges, duration) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const kept = [];
  let at = 0;
  for (const r of sorted) {
    if (r.start - at > 0.04) kept.push({ start: round3(at), end: round3(r.start), speed: 1, label: '' });
    at = Math.max(at, r.end);
  }
  if (duration - at > 0.04) kept.push({ start: round3(at), end: round3(duration), speed: 1, label: '' });
  return kept;
}

function atempoChain(speed) {
  const parts = [];
  let rest = speed;
  while (rest > 2.0001) { parts.push('atempo=2.0'); rest /= 2; }
  while (rest < 0.4999) { parts.push('atempo=0.5'); rest /= 0.5; }
  if (Math.abs(rest - 1) > 0.001) parts.push(`atempo=${rest.toFixed(4)}`);
  return parts;
}

const metaEscape = (s) => String(s).replace(/([=;#\\\n])/g, '\\$1');

/** Render an edit list. `baseDir` resolves a relative `source`. */
export async function render(edl, outFile, baseDir = process.cwd()) {
  const src = path.resolve(baseDir, edl.source);
  const info = await probe(src);
  const out = { maxWidth: 1920, fps: 30, crf: 20, cardColor: '0x0f172a', ...(edl.output ?? {}) };

  const segments = (edl.segments ?? [])
    .map((s) => s.image
      ? { ...s, image: path.resolve(baseDir, s.image), duration: Number(s.duration ?? 4) }
      : {
          ...s,
          start: clamp(parseTime(s.start), 0, info.duration),
          end: clamp(parseTime(s.end), 0, info.duration),
          speed: Number(s.speed ?? 1),
        })
    .filter((s) => (s.image ? s.duration > 0 : s.end - s.start >= 0.04));
  if (!segments.some((s) => !s.image)) throw new Error('The edit list keeps nothing: no segment has a positive length.');
  for (const s of segments) {
    if (!s.image && !(s.speed > 0)) throw new Error(`Segment ${fmtTime(s.start)}-${fmtTime(s.end)} has an invalid speed.`);
  }

  // One output size for every segment, so recorded footage and still images can be joined.
  let crop = null;
  if (edl.crop) {
    const x = clamp(Math.round(edl.crop.x), 0, info.width - 2);
    const y = clamp(Math.round(edl.crop.y), 0, info.height - 2);
    crop = { x, y, w: even(Math.min(edl.crop.w, info.width - x)), h: even(Math.min(edl.crop.h, info.height - y)) };
  }
  const baseW = crop ? crop.w : info.width;
  const baseH = crop ? crop.h : info.height;
  const W = even(Math.min(out.maxWidth, baseW));
  const H = even(Math.round((baseH * W) / baseW));
  const geometry = [...(crop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []), `scale=${W}:${H}:flags=lanczos`];
  const fit = [`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${out.cardColor}`];

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const filters = [];
  const pads = [];
  let input = 0;
  let outTime = 0;
  const outStarts = [];
  segments.forEach((s, k) => {
    if (s.image) {
      args.push('-loop', '1', '-framerate', String(out.fps), '-t', s.duration.toFixed(3), '-i', s.image);
      filters.push(`[${input}:v]${fit.join(',')},fps=${out.fps},format=yuv420p,setsar=1[v${k}]`);
      input++;
      pads.push(`[v${k}]`);
      if (info.hasAudio) {
        args.push('-f', 'lavfi', '-t', s.duration.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
        filters.push(`[${input}:a]aresample=async=1[a${k}]`);
        input++;
        pads.push(`[a${k}]`);
      }
      outStarts.push(outTime);
      outTime += s.duration;
      return;
    }
    args.push('-ss', s.start.toFixed(3), '-t', (s.end - s.start).toFixed(3), '-i', src);
    filters.push(
      `[${input}:v]setpts=(PTS-STARTPTS)/${s.speed},${geometry.join(',')},fps=${out.fps},format=yuv420p,setsar=1[v${k}]`,
    );
    pads.push(`[v${k}]`);
    if (info.hasAudio) {
      filters.push(`[${input}:a]${['asetpts=PTS-STARTPTS', ...atempoChain(s.speed), 'aresample=async=1'].join(',')}[a${k}]`);
      pads.push(`[a${k}]`);
    }
    input++;
    outStarts.push(outTime);
    outTime += (s.end - s.start) / s.speed;
  });
  filters.push(`${pads.join('')}concat=n=${segments.length}:v=1:a=${info.hasAudio ? 1 : 0}[v]${info.hasAudio ? '[a]' : ''}`);

  // Chapters: explicit ones (source times, or a segment index for stills) or segment labels.
  const toOut = (t) => {
    for (let k = 0; k < segments.length; k++) {
      const s = segments[k];
      if (s.image) continue;
      if (t >= s.start - 0.001 && t <= s.end + 0.001) return outStarts[k] + (t - s.start) / s.speed;
    }
    return null;
  };
  const marks = (edl.chapters?.length
    ? edl.chapters.map((c) => ({ at: c.segment != null ? outStarts[c.segment] ?? null : toOut(parseTime(c.at)), label: c.label }))
    : segments.map((s, k) => ({ at: outStarts[k], label: s.label })).filter((c) => c.label && !c.label.startsWith('('))
  ).filter((c) => c.at != null && c.label).sort((a, b) => a.at - b.at);

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  let metaFile = null;
  if (marks.length) {
    metaFile = `${outFile}.chapters.txt`;
    const lines = [';FFMETADATA1'];
    marks.forEach((c, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].at : outTime;
      lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.at * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${metaEscape(c.label)}`);
    });
    await fs.writeFile(metaFile, lines.join('\n') + '\n');
    args.push('-f', 'ffmetadata', '-i', metaFile);
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[v]');
  if (info.hasAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  if (metaFile) args.push('-map_chapters', String(input));
  if (await hasEncoder('libx264')) args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(out.crf));
  else args.push('-c:v', 'h264_videotoolbox', '-b:v', '6M');
  args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile);

  const r = await run('ffmpeg', args);
  if (metaFile) await fs.rm(metaFile, { force: true });
  if (r.code !== 0) throw new Error(`ffmpeg failed while cutting:\n${r.stderr.trim().split('\n').slice(-8).join('\n')}`);
  const result = await probe(outFile);
  return { outFile, duration: result.duration, width: result.width, height: result.height, sourceDuration: info.duration, segments: segments.length };
}

/** LosslessCut "CSV" import format: start,end,label in seconds, one segment per line. */
export async function writeLosslessCutCsv(edl, file) {
  // Still-image segments (title cards) have no place in the source video, so LosslessCut gets the footage only.
  const rows = edl.segments.filter((s) => !s.image)
    .map((s) => `${Number(s.start).toFixed(3)},${Number(s.end).toFixed(3)},${String(s.label ?? '').replace(/[",\n]/g, ' ')}`);
  await fs.writeFile(file, rows.join('\n') + '\n');
}

/** moments.json -> edit.json (+ segments.csv) -> final video. Used by record.mjs too. */
export async function cutFromMoments(momentsFile, opts = {}) {
  const dir = path.dirname(path.resolve(momentsFile));
  const doc = JSON.parse(await fs.readFile(momentsFile, 'utf8'));
  const frame = opts.frame ?? doc.frame ?? 'window';
  const stills = opts.keepStills
    ? []
    : await detectStills(path.resolve(dir, doc.video), frame === 'window' ? doc.crop : null, { minDuration: Number(opts.maxIdle ?? 1.5) });
  const edl = planEdit(doc, { ...opts, stills });
  const edlFile = path.join(dir, 'edit.json');
  await fs.writeFile(edlFile, JSON.stringify(edl, null, 2) + '\n');
  const csvFile = path.join(dir, 'segments.csv');
  await writeLosslessCutCsv(edl, csvFile);
  if (opts.planOnly) return { edlFile, csvFile, stillSecondsRemoved: edl.stillSecondsRemoved, segments: edl.segments };
  const outFile = path.resolve(opts.out ?? path.join(dir, `${doc.name || 'demo'}.mp4`));
  const result = await render(edl, outFile, dir);
  return { edlFile, csvFile, stillSecondsRemoved: edl.stillSecondsRemoved, ...result };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2), ['plan-only', 'csv', 'keep-stills', 'help']);
  if (flags.help || (!flags.moments && !flags.edl && !positional.length)) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 1);
  }
  const opts = {
    frame: flags.frame, maxWidth: flags['max-width'], maxIdle: flags['max-idle'],
    maxSpeed: flags['max-speed'], crf: flags.crf, out: flags.out, planOnly: !!flags['plan-only'],
    keepStills: !!flags['keep-stills'],
  };

  if (flags.moments) {
    const r = await cutFromMoments(flags.moments, opts);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  let edl;
  let baseDir;
  let defaultOut;
  if (flags.edl) {
    const edlPath = path.resolve(flags.edl);
    edl = JSON.parse(await fs.readFile(edlPath, 'utf8'));
    baseDir = path.dirname(edlPath);
    const srcPath = path.resolve(baseDir, edl.source);
    defaultOut = path.join(baseDir, `${path.basename(srcPath, path.extname(srcPath))}.cut.mp4`);
  } else {
    const src = path.resolve(positional[0]);
    const info = await probe(src);
    if (!flags.keep && !flags.remove) throw new Error('Give --keep or --remove ranges (or --edl / --moments).');
    const segments = flags.keep ? parseRanges(flags.keep, info.duration) : complement(parseRanges(flags.remove, info.duration), info.duration);
    edl = { version: 1, source: src, crop: null, output: {}, segments };
    baseDir = path.dirname(src);
    defaultOut = path.join(baseDir, `${path.basename(src, path.extname(src))}.cut.mp4`);
  }
  if (flags['max-width']) edl.output = { ...(edl.output ?? {}), maxWidth: Number(flags['max-width']) };
  if (flags.crf) edl.output = { ...(edl.output ?? {}), crf: Number(flags.crf) };
  const outFile = path.resolve(flags.out ?? defaultOut);
  const extra = {};
  if (flags.csv) {
    extra.csvFile = outFile.replace(/\.[^.]+$/, '') + '.segments.csv';
    await writeLosslessCutCsv(edl, extra.csvFile);
  }
  if (flags['plan-only']) { console.log(JSON.stringify({ ...extra, segments: edl.segments }, null, 2)); return; }
  const r = await render(edl, outFile, baseDir);
  console.log(JSON.stringify({ ...extra, ...r }, null, 2));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
}
