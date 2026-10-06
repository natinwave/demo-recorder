// Screen capture with ffmpeg: avfoundation on macOS, x11grab on Linux.
import { spawn } from 'node:child_process';
import { run, sleep } from './util.mjs';

/** macOS: list avfoundation devices and return the screen-capture ones. */
export async function listMacScreens() {
  const r = await run('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
  const screens = [];
  for (const line of r.stderr.split('\n')) {
    const m = line.match(/\[(\d+)\]\s+Capture screen (\d+)/);
    if (m) screens.push({ device: Number(m[1]), screen: Number(m[2]) });
  }
  return { screens, raw: r.stderr };
}

async function inputArgs({ fps, screenSize, screenIndex }) {
  if (process.platform === 'darwin') {
    const { screens } = await listMacScreens();
    const wanted = screens.find((s) => s.screen === screenIndex) ?? screens[0];
    // Fall back to the device name if the list could not be parsed.
    const device = wanted ? String(wanted.device) : `Capture screen ${screenIndex}`;
    return [
      '-f', 'avfoundation',
      '-capture_cursor', '0',
      '-framerate', String(fps),
      '-pixel_format', 'uyvy422',
      '-i', `${device}:none`,
    ];
  }
  if (process.platform === 'linux') {
    const display = process.env.DISPLAY;
    if (!display) throw new Error('DISPLAY is not set; an X display is needed to record on Linux.');
    return [
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-framerate', String(fps),
      '-video_size', `${screenSize.width}x${screenSize.height}`,
      '-i', display,
    ];
  }
  throw new Error(`Screen capture is not set up for platform "${process.platform}".`);
}

function encoderChain() {
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18'];
  const vt = ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '14M'];
  if (process.env.DEMO_ENCODER === 'x264') return [x264];
  if (process.env.DEMO_ENCODER === 'videotoolbox') return [vt];
  return process.platform === 'darwin' ? [vt, x264] : [x264];
}

/**
 * Start recording the screen. Resolves once frames are flowing.
 * Returns { stop(), t0Estimate(), stderr() }.
 */
export async function startCapture({ outFile, fps = 30, screenSize, screenIndex = 0, maxSeconds = 900 }) {
  const input = await inputArgs({ fps, screenSize, screenIndex });
  const errors = [];
  for (const encoder of encoderChain()) {
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-progress', 'pipe:1', '-stats_period', '0.1',
      ...input,
      '-t', String(maxSeconds),
      '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
      '-fps_mode', 'cfr', '-r', String(fps),
      ...encoder,
      '-g', String(Math.round(fps / 2)),
      '-pix_fmt', 'yuv420p',
      '-y', outFile,
    ];
    try {
      return await launch(args);
    } catch (err) {
      errors.push(`${encoder[1]}: ${err.message}`);
    }
  }
  throw new Error(`Could not start screen capture.\n${errors.join('\n')}`);
}

function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let exited = false;
    let started = false;
    // Wall-clock time of video t=0. Each progress report (wall T, video t) gives
    // T - t >= t0, so the smallest value seen is the best estimate.
    let t0 = Infinity;
    let buffer = '';

    const exitPromise = new Promise((res) => child.on('close', (code) => { exited = true; res(code); }));

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => {
      const now = Date.now();
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/);
        if (!m) continue;
        const us = Number(m[1]);
        if (us <= 0) continue;
        t0 = Math.min(t0, now - us / 1000);
        if (!started && us > 200000) {
          started = true;
          clearTimeout(timer);
          resolve(handle);
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === 'ENOENT' ? 'ffmpeg is not installed (on macOS: brew install ffmpeg).' : String(err)));
    });
    exitPromise.then((code) => {
      if (!started) {
        clearTimeout(timer);
        reject(new Error(`ffmpeg exited (${code}) before recording started: ${stderr.trim().split('\n').slice(-6).join(' | ')}`));
      }
    });
    const timer = setTimeout(() => {
      if (started) return;
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg produced no frames within 20s: ${stderr.trim().split('\n').slice(-6).join(' | ')}`));
    }, 20000);

    const handle = {
      t0Estimate: () => t0,
      stderr: () => stderr,
      async stop() {
        if (exited) return;
        try { child.stdin.write('q\n'); } catch { /* already gone */ }
        const done = await Promise.race([exitPromise.then(() => true), sleep(8000).then(() => false)]);
        if (done) return;
        child.kill('SIGINT');
        const done2 = await Promise.race([exitPromise.then(() => true), sleep(5000).then(() => false)]);
        if (!done2) child.kill('SIGKILL');
        await exitPromise;
      },
    };
  });
}

/**
 * Find the sync flash (green -> magenta) inside `box` (video pixels).
 * Returns the video time of the first magenta frame, or null.
 */
export async function findFlash(video, box, fps, searchSeconds = 20) {
  const r = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-t', String(searchSeconds), '-i', video,
    '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y},scale=1:1:flags=area`,
    '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-',
  ], { binary: true });
  if (r.code !== 0 || r.stdout.length < 3) return null;
  const px = r.stdout;
  const isGreen = (i) => px[i + 1] > 170 && px[i] < 165 && px[i + 2] < 165;
  const isMagenta = (i) => px[i] > 170 && px[i + 2] > 170 && px[i + 1] < 120;
  let greenSeenAt = -1;
  for (let f = 0; f * 3 + 2 < px.length; f++) {
    const i = f * 3;
    if (isGreen(i)) greenSeenAt = f;
    else if (isMagenta(i) && greenSeenAt !== -1 && f - greenSeenAt <= 3) return f / fps;
  }
  return null;
}
