/**
 * Demo video from REAL model-input frames. Zero dependencies (ffmpeg on PATH).
 *
 * The video is a byproduct of running the automation, not a reconstruction of
 * it: `GET /v1/runs/{id}/screenshots` returns the exact images the agent looked
 * at before each decision, so the footage cannot disagree with what happened.
 * There is no storyboard to author and nothing to keep in sync.
 *
 * Verification is intrinsic. Frames carry a `sha256` we re-check against the
 * bytes, a `degraded` flag set when the agent had to act on a stale frame, and
 * a flat monotonic `index`, so `assertVideoSane()` can pass or fail the result
 * without a human watching it.
 */
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

/** Pacing bounds. A slow step must not stall the video; a fast one must stay readable. */
const MIN_HOLD_S = 0.6;
const MAX_HOLD_S = 2.5;
const FINAL_HOLD_S = 1.8;

export class FfmpegMissingError extends Error {
  constructor() {
    super(
      'ffmpeg is not on PATH. Install it to render demo videos:\n' +
        '  macOS    brew install ffmpeg\n' +
        '  Ubuntu   sudo apt-get install -y ffmpeg\n' +
        '  Windows  winget install Gyan.FFmpeg',
    );
    this.name = 'FfmpegMissingError';
    this.code = 'FFMPEG_MISSING';
  }
}

export async function hasFfmpeg() {
  try {
    await exec('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download every model-input frame for a run.
 * Scratch lives in the OS temp dir, never the repo: OneDrive locks repo folders
 * and breaks cleanup.
 */
export async function downloadFrames(client, runId, { workDir } = {}) {
  const dir = workDir ?? path.join(os.tmpdir(), 'coasty-capture', runId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const frames = [];
  let skipped = 0;
  for await (const f of client.frames(runId)) {
    if (f.image_unavailable || !f.image_b64) {
      skipped++;
      continue;
    }
    const buf = Buffer.from(f.image_b64, 'base64');
    const actual = createHash('sha256').update(buf).digest('hex');
    if (f.sha256 && f.sha256 !== actual) {
      throw new Error(`Frame ${f.index} failed its integrity check (sha256 mismatch)`);
    }
    const file = path.join(dir, `f${String(f.index).padStart(4, '0')}.png`);
    await writeFile(file, buf);
    frames.push({ ...f, file, bytes: buf.length, sha256: actual });
  }
  return { dir, frames, skipped };
}

/** Per-frame hold, paced from real capture timestamps and clamped. */
export function computeHolds(frames) {
  return frames.map((f, i) => {
    if (i === frames.length - 1) return FINAL_HOLD_S;
    const dt = (Date.parse(frames[i + 1].taken_at) - Date.parse(f.taken_at)) / 1000;
    return Number.isFinite(dt) && dt > 0 ? Math.min(MAX_HOLD_S, Math.max(MIN_HOLD_S, dt)) : 1.2;
  });
}

/**
 * Encode frames to mp4 (+ optional gif and poster).
 *
 * The ffmpeg idiom here is measured, not assumed. All three parts are required:
 *   1. repeat the final file bare — the concat demuxer DISCARDS the last
 *      entry's `duration`, so without the repeat the closing frame flashes past;
 *   2. resample with `fps=` INSIDE -vf, never `-r` as an output option. `-r`
 *      re-times the variable-rate concat stream and silently truncates the tail
 *      (measured: 7.17s emitted for an 8.40s timeline);
 *   3. bound with `-t sum(holds)`, because the bare repeat inherits the previous
 *      entry's duration and would otherwise overshoot (measured: 10.20s).
 */
export async function encode(frames, outDir, { gif = true, fps = 30, width = 1280 } = {}) {
  if (!(await hasFfmpeg())) throw new FfmpegMissingError();
  if (frames.length === 0) throw new Error('No frames to encode');
  await mkdir(outDir, { recursive: true });

  const holds = computeHolds(frames);
  const totalS = holds.reduce((a, b) => a + b, 0);
  const posix = (p) => p.replace(/\\/g, '/');

  const listFile = path.join(outDir, 'concat.txt');
  await writeFile(
    listFile,
    `${[
      ...frames.map((f, i) => `file '${posix(f.file)}'\nduration ${holds[i].toFixed(3)}`),
      `file '${posix(frames.at(-1).file)}'`,
    ].join('\n')}\n`,
  );

  const mp4 = path.join(outDir, 'demo.mp4');
  await exec('ffmpeg', [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-t', totalS.toFixed(3),
    '-vf', `scale=${width}:-2:flags=lanczos,format=yuv420p,fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart',
    mp4,
  ]);

  // Poster: the last frame is the result the agent arrived at.
  const poster = path.join(outDir, 'poster.jpg');
  await exec('ffmpeg', ['-y', '-i', posix(frames.at(-1).file), '-vf', `scale=${width}:-2`, '-q:v', '3', poster]);

  let gifPath;
  if (gif) {
    gifPath = path.join(outDir, 'demo.gif');
    const pal = path.join(outDir, 'palette.png');
    const chain = 'fps=10,scale=960:-1:flags=lanczos';
    await exec('ffmpeg', ['-y', '-i', mp4, '-vf', `${chain},palettegen=stats_mode=diff`, pal]);
    await exec('ffmpeg', ['-y', '-i', mp4, '-i', pal, '-lavfi',
      `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`, gifPath]);
    await rm(pal, { force: true });
  }
  await rm(listFile, { force: true });

  return { mp4, gif: gifPath, poster, totalS, holds };
}

/** ffprobe → { durationS, width, height, packets }. */
export async function probe(file) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'format=duration:stream=width,height,nb_read_packets',
    '-count_packets', '-of', 'json', file,
  ]);
  const j = JSON.parse(stdout);
  const s = j.streams[0] ?? {};
  return {
    durationS: Number(j.format.duration),
    width: s.width,
    height: s.height,
    packets: Number(s.nb_read_packets),
  };
}

/**
 * Pass/fail the rendered video with no human in the loop. Returns a list of
 * {name, ok, detail}; the caller decides what to do with failures.
 */
export async function assertVideoSane({ frames, run, encoded, probed, expectWidth = 1280 }) {
  const degraded = frames.filter((f) => f.degraded).length;
  const distinct = new Set(frames.map((f) => f.sha256)).size;
  const checks = [
    ['frames captured', frames.length > 0, `${frames.length} frames`],
    [
      'frame count matches steps',
      run?.steps_completed == null || frames.length === run.steps_completed,
      `${frames.length} frames vs ${run?.steps_completed} steps`,
    ],
    ['not all frames degraded', degraded < frames.length, `${degraded} degraded`],
    ['frames are distinct', distinct === frames.length, `${distinct}/${frames.length} unique`],
    [
      'duration matches pacing',
      Math.abs(probed.durationS - encoded.totalS) < 0.5,
      `${probed.durationS.toFixed(2)}s vs ${encoded.totalS.toFixed(2)}s expected`,
    ],
    ['stream width correct', probed.width === expectWidth, `${probed.width}x${probed.height}`],
    ['video is non-trivial', probed.packets > 1, `${probed.packets} packets`],
  ];
  return checks.map(([name, ok, detail]) => ({ name, ok, detail }));
}

/** Human-readable size, for the console summary. */
export async function fileSize(p) {
  const { size } = await stat(p);
  return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024).toFixed(0)} KB`;
}
