import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a command, collect stdout/stderr. Never throws on non-zero exit. */
export function run(cmd, args, { input, binary = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: 127, stdout: binary ? Buffer.alloc(0) : '', stderr: String(err) });
      return;
    }
    const out = [];
    const errChunks = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.on('error', (err) =>
      resolve({ code: 127, stdout: binary ? Buffer.alloc(0) : '', stderr: String(err) }),
    );
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      resolve({
        code: code ?? 1,
        stdout: binary ? stdout : stdout.toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

/** Tiny argv parser: --flag, --key value, --key=value, positionals. */
export function parseArgs(argv, booleans = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = argv[++i];
    }
  }
  return { flags, positional };
}

/** "83.5", "1:23.5" or "0:01:23.5" -> seconds. */
export function parseTime(value) {
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) throw new Error(`Cannot read time "${value}"`);
  return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

export function fmtTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return `${m}:${rest}`;
}

export const round3 = (n) => Math.round(n * 1000) / 1000;
export const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

export async function probe(file) {
  const r = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration',
    '-of', 'json',
    file,
  ]);
  if (r.code !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr.trim()}`);
  const info = JSON.parse(r.stdout);
  const video = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!video) throw new Error(`No video stream in ${file}`);
  const [num, den] = String(video.r_frame_rate || '30/1').split('/').map(Number);
  return {
    width: video.width,
    height: video.height,
    fps: den ? num / den : num,
    duration: Number(info.format?.duration ?? 0),
    hasAudio: (info.streams || []).some((s) => s.codec_type === 'audio'),
  };
}

export async function hasEncoder(name) {
  const r = await run('ffmpeg', ['-hide_banner', '-encoders']);
  return new RegExp(`\\s${name}\\s`).test(r.stdout);
}
