/**
 * Will cue snapping help on this recording?
 *
 * Cue cuts are estimated from character counts and then moved onto a real
 * pause found by ffmpeg. That only works if the pauses are there to find. This
 * measures whether they are: for every cue boundary in an approved subtitle
 * file, it asks whether a micro-pause was detected within 150 ms. The result is
 * the CEILING on what snapping can achieve for this episode.
 *
 * It needs no transcription and costs no API calls — just the video and a
 * subtitle file someone has already approved.
 *
 *   node scripts/pause-ceiling.mjs <video> <approved.srt>
 *   node scripts/pause-ceiling.mjs <cases.json>
 *
 * cases.json is [{ "name": "...", "video": "...", "srt": "..." }, ...].
 *
 * Reading the number:
 *   above ~40%   snapping has real material to work with
 *   10-40%       some benefit, worth checking against the reference caption
 *   under ~10%   the pauses are not detectable in this audio. No tuning will
 *                fix it, and only word-level timing will improve cue timing.
 *
 * Measured so far: a clean studio recording scores 53%, and a 1999 broadcast
 * with a high tape noise floor scores 0.3%.
 */

import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { detectSilences, MICRO_NOISE, MICRO_MIN } from '../server/services/transcribe.js';
import { FFMPEG_BIN } from '../server/paths.js';

const TOLERANCE = 0.15; // seconds — how close a pause must be to count

function parseSrt(path) {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;
    const m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) continue;
    cues.push({
      start: +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000,
      end: +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000,
    });
  }
  return cues;
}

function extractWav(video, out) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_BIN, [
      '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out,
    ]);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))));
  });
}

async function measure(name, video, srt, scratch) {
  const wav = join(scratch, 'audio.wav');
  await extractWav(video, wav);

  let ref = parseSrt(srt);
  if (!ref.length) throw new Error(`no cues parsed from ${srt}`);

  const pauses = await detectSilences(wav, MICRO_NOISE, MICRO_MIN);
  const mids = pauses.map(([s, e]) => (s + e) / 2);

  // The subtitle file may cover a whole episode while the video is an excerpt.
  const audioEnd = pauses.length ? pauses[pauses.length - 1][1] : Infinity;
  const windowed = ref.filter((c) => c.start < audioEnd);
  if (windowed.length) ref = windowed;

  const span = ref[ref.length - 1].end - ref[0].start;
  const hit = ref.filter((c) => mids.some((m) => Math.abs(m - c.start) <= TOLERANCE)).length;
  const pct = (100 * hit) / ref.length;

  console.log(
    `${name.padEnd(24)} ${String(ref.length).padStart(5)} cues  ${(span / 60).toFixed(1).padStart(5)}m  ` +
    `${String(pauses.length).padStart(6)} pauses (${(pauses.length / span).toFixed(2)}/s)  ` +
    `ceiling ${pct.toFixed(1)}%`
  );
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/pause-ceiling.mjs <video> <approved.srt>');
  console.error('   or: node scripts/pause-ceiling.mjs <cases.json>');
  process.exit(2);
}

const cases = args.length === 1
  ? JSON.parse(readFileSync(args[0], 'utf8'))
  : [{ name: args[0].split(/[\\/]/).pop(), video: args[0], srt: args[1] }];

console.log(`micro-pause detection at ${MICRO_NOISE} / ${MICRO_MIN}s, boundaries matched within ${TOLERANCE * 1000}ms\n`);
const scratch = mkdtempSync(join(tmpdir(), 'pause-ceiling-'));
try {
  for (const c of cases) {
    try {
      await measure(c.name ?? c.video, c.video, c.srt, scratch);
    } catch (err) {
      console.log(`${(c.name ?? c.video).padEnd(24)} FAILED: ${err.message}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
