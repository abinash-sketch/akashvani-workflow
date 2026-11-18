/**
 * Re-run cue building offline and score it against a reference caption.
 *
 * Transcription saves a `.raw.json` beside every SRT — the segment boundaries
 * plus each segment's raw Sarvam response. That file is the exact input to
 * segmentToCues, so cue shaping can be re-run and re-scored as often as we
 * like without spending a single API call or needing the source video.
 *
 *   node scripts/srt-compare.mjs <input.raw.json> [reference.srt] [media]
 *   node scripts/srt-compare.mjs <ours.srt> <reference.srt>     (compare only)
 *
 * `media` is the episode's video or audio. Micro-pauses are not stored in the
 * .raw.json, so pass the media to replay cue snapping exactly as a real run
 * would do it. Without it the character estimate stands, which is the Stage 1
 * behaviour and still a useful comparison point.
 *
 * With a reference, the numbers that matter are the ceilings (a reference
 * caption never exceeds its own char/duration limits) and boundary agreement:
 * what share of reference cue boundaries we also place, within 150 ms.
 */

import { readFileSync, writeFileSync } from 'fs';
import {
  segmentToCues, buildSrt, detectSilences, MICRO_NOISE, MICRO_MIN,
} from '../server/services/transcribe.js';

const NEAR = 0.15; // seconds — a boundary this close counts as the same boundary

export function parseSrt(path) {
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
      text: lines.slice(2).join(' ').trim(),
      lines: lines.length - 2,
    });
  }
  return cues;
}

function cuesFromRaw(path, pauses) {
  const segments = JSON.parse(readFileSync(path, 'utf8'));
  const cues = [];
  for (const seg of segments) {
    if (!seg.response) continue;
    cues.push(...segmentToCues(seg.start, seg.end, seg.response.transcript || '', pauses));
  }
  return { cues, segments: segments.length };
}

const quantile = (sorted, p) => sorted[Math.floor((sorted.length - 1) * p)];

function describe(label, cues) {
  const durs = cues.map((c) => c.end - c.start).sort((a, b) => a - b);
  const chars = cues.map((c) => c.text.length).sort((a, b) => a - b);
  const over4 = cues.filter((c) => c.end - c.start > 4).length;
  const over36 = cues.filter((c) => c.text.length > 36).length;
  const pct = (n) => `${n} (${((100 * n) / cues.length).toFixed(1)}%)`;
  console.log(`\n== ${label} ==`);
  console.log(`  cues             ${cues.length}`);
  console.log(`  duration med/max ${quantile(durs, 0.5).toFixed(2)}s / ${durs[durs.length - 1].toFixed(2)}s`);
  console.log(`  chars    med/max ${quantile(chars, 0.5)} / ${chars[chars.length - 1]}`);
  console.log(`  over 4.0s        ${pct(over4)}`);
  console.log(`  over 36 chars    ${pct(over36)}`);
}

/** Share of `ref` cue starts that `ours` also places within NEAR seconds. */
function boundaryAgreement(ours, ref) {
  const mine = ours.map((c) => c.start).sort((a, b) => a - b);
  let hit = 0;
  for (const r of ref.map((c) => c.start)) {
    // binary search for the closest of ours
    let lo = 0;
    let hi = mine.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mine[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const near = [mine[lo - 1], mine[lo], mine[lo + 1]].filter((x) => x !== undefined);
    if (near.some((x) => Math.abs(x - r) <= NEAR)) hit++;
  }
  return { hit, total: ref.length };
}

const [input, reference, media] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/srt-compare.mjs <input.raw.json|ours.srt> [reference.srt] [media]');
  process.exit(2);
}

let pauses = [];
if (media) {
  pauses = await detectSilences(media, MICRO_NOISE, MICRO_MIN);
  console.log(`${pauses.length} micro-pauses detected in ${media}`);
} else if (input.endsWith('.raw.json')) {
  console.log('(no media given — cue cuts use the character estimate, not real pauses)');
}

let ours;
if (input.endsWith('.raw.json')) {
  const built = cuesFromRaw(input, pauses);
  ours = built.cues;
  const out = input.replace(/\.raw\.json$/, '.rebuilt.srt');
  writeFileSync(out, buildSrt(ours.map((c) => ({ ...c }))), 'utf8');
  console.log(`rebuilt ${ours.length} cues from ${built.segments} segments -> ${out}`);
} else {
  ours = parseSrt(input);
}

describe('OURS', ours);

if (reference) {
  // A reference caption usually covers the whole episode while the input may
  // be an excerpt. Score only the overlapping span, or the counts are
  // meaningless.
  const from = ours[0].start;
  const to = ours[ours.length - 1].end;
  const all = parseSrt(reference);
  const ref = all.filter((c) => c.end > from && c.start < to);
  if (ref.length !== all.length) {
    console.log(`\n(reference windowed to ${from.toFixed(1)}s..${to.toFixed(1)}s: ${ref.length} of ${all.length} cues)`);
  }
  describe('REFERENCE', ref);
  const a = boundaryAgreement(ours, ref);
  console.log(
    `\nboundary agreement (±${NEAR * 1000}ms): ${a.hit}/${a.total} = ${((100 * a.hit) / a.total).toFixed(1)}%`
  );
  console.log(`cue count ratio: ${(ours.length / ref.length).toFixed(2)}x reference`);
}
