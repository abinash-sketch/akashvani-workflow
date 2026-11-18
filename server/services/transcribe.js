/**
 * Automatic subtitle generation via Sarvam Saaras.
 *
 * This replaces the manual trip out to a third-party transcription tool: the
 * editor no longer exports audio, uploads it somewhere else, waits, downloads
 * an .srt and brings it back. The app does the whole thing from the episode's
 * own compressed video.
 *
 * WHY SILENCE-BASED SEGMENTATION (and not the model's own timestamps):
 *   Saaras' real-time REST endpoint returns utterance-level timing — one entry
 *   spanning the whole clip — and diarization is batch-API only. Trusting that
 *   would give us subtitles with no usable cue boundaries. So we cut the audio
 *   at silences DETECTED BY FFMPEG (millisecond precision), transcribe each
 *   speech segment on its own, and use the segment's real start/end as the cue
 *   timing. The timings are therefore measured, not inferred.
 *
 * Steps:
 *   1. Extract mono 16 kHz WAV from the video (what Saaras expects).
 *   2. Detect silences, build speech segments, merge/split them to 1–29 s.
 *   3. Transcribe every segment with mode=transcribe, so Hindi audio comes
 *      back as Hindi text rather than being translated to English.
 *   4. Emit SRT cues at HH:MM:SS,mmm precision, splitting long transcripts
 *      into sentence/clause cues with time shared out by text length.
 *
 * Started as a direct port of the Python prototype in test-sarvam-models/,
 * parameter-for-parameter identical. The SEGMENTATION constants still match it.
 * The CUE SHAPING constants no longer do: they were re-tuned against a Premiere
 * Pro reference caption of the same speech (see MAX_CUE_CHARS below). Re-check
 * a real episode before changing either group.
 */

import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { FFMPEG_BIN, FFPROBE_BIN } from '../paths.js';
import { logInfo, logWarn } from './logger.js';

const API_URL = 'https://api.sarvam.ai/speech-to-text';

export const DEFAULT_MODEL = 'saaras:v3';
/** Same-language output. "translate" would hand back English — not what we want. */
const MODE = 'transcribe';
export const DEFAULT_LANGUAGE = 'hi-IN';

const MAX_WORKERS = 3;   // parallel API calls; higher reliably trips rate limits
const MAX_RETRIES = 4;   // per segment, covers 429 and 5xx

// ── segmentation tuning ─────────────────────────────────────────────────────
// Tuned for phrase-level, closed-caption-style cues: split at the short pauses
// between phrases rather than only at sentence ends.
const SILENCE_NOISE = '-30dB'; // noise floor for silencedetect
const SILENCE_MIN = 0.20;      // min silence (s) that counts as a boundary
const SEG_PAD = 0.10;          // widen each segment both ways so words aren't clipped
const MERGE_GAP = 0.30;        // merge neighbours closer than this
const MERGE_MAX = 5.0;         // ...but never grow a merged segment past this
const HARD_MAX = 29.0;         // REST endpoint caps at 30 s — force-split above this
const MIN_SEG = 0.25;          // drop blips shorter than this

// ── micro-pause detection (cue boundaries only) ─────────────────────────────
// The constants above decide what gets SENT to the API, and must stay coarse:
// a segment needs enough context to transcribe well, and more segments means
// more calls. But a pause has to be ~0.5 s to survive them (0.20 s to be seen
// at all, then SEG_PAD eats 0.20 s, then MERGE_GAP closes anything under
// 0.30 s), and in the Premiere Pro reference only 11% of cue boundaries have a
// gap that big — half sit in the 0.05–0.10 s band. So we run a second, far more
// sensitive pass purely to find candidate CUT POINTS inside a segment we have
// already transcribed. It costs one more ffmpeg pass and no API calls.
// Swept on the extracted WAV against reference captions of two real episodes.
//
//   Clean studio audio: agreement with the reference's cue boundaries
//   (±150 ms) was 30.0% unsnapped, and peaks on a plateau from -40 to -45 dB
//   at 40.5%. Looser is actively worse — at -30 dB the 1059 "pauses" found are
//   mostly noise and agreement falls to 29.5%.
//
//   A 1999 broadcast recording: snapping does not help AT ALL. Unsnapped
//   agreement is 50.2% and no threshold beats it; the tape noise floor means
//   -35 dB reports a "pause" every half second that has nothing to do with
//   speech. Pre-filtering (highpass+lowpass+afftdn) made it worse still, ~48%.
//
// -40 dB is what makes that second case harmless rather than damaging: it
// finds only 26 pauses in 26 minutes of that recording, so snapping degrades
// to the character estimate instead of chasing noise. Note there is no runtime
// signal that tells the two cases apart — pause DENSITY does not, since the
// noisy file at -35 dB is sparser (0.90/s) than the clean one at its best
// setting (1.07/s) and still hurts. So resist making this adaptive without
// evidence; strictness is the only protection we have.
export const MICRO_NOISE = '-40dB';
export const MICRO_MIN = 0.04; // 40 ms — short enough to catch a breath
const SNAP_WINDOW = 0.70;      // never move a cut further than this to reach one
const SNAP_FRACTION = 0.45;    // ...nor by more than this much of the shorter side

// ── cue shaping ─────────────────────────────────────────────────────────────
// Ceilings measured off a Premiere Pro reference caption of the same speech
// (713 cues): PP never exceeds 35 characters or 3.36 s. Ours allowed 42 chars
// and had no duration limit at all, so a short line spoken slowly across pauses
// we had merged away sat on screen for 9 s. Both limits now bind.
const MAX_CUE_CHARS = 35;      // single-line phrase cues
const MAX_CUE_DURATION = 3.5;  // no cue stays up longer than this if it can be split
const MIN_CUE_CHARS = 12;      // floor on the duration-derived budget, so a long
                               // near-silent segment isn't shredded word by word
const MIN_CUE_DURATION = 0.5;  // pad ultra-short cues so they stay readable

/** Labels the model hallucinates over music beds and room noise. */
const JUNK_TRANSCRIPTS = new Set([
  'music', '[music]', 'म्यूजिक', 'संगीत', 'noise', '[noise]',
]);

/**
 * Every ffmpeg child this module has running. Pressing Stop must actually end
 * the work, not just hide it — without this, ffmpeg and a queue of API calls
 * would carry on in the background after the UI said the run had stopped.
 */
const liveProcs = new Set();

/** Kill in-flight audio work. Returns how many processes were killed. */
export function killActiveTranscriptions() {
  let killed = 0;
  for (const proc of liveProcs) {
    try { proc.kill('SIGKILL'); killed++; } catch { /* already gone */ }
  }
  liveProcs.clear();
  return killed;
}

/** Thrown when a run was deliberately stopped, so callers can tell it apart. */
export class TranscriptionStoppedError extends Error {
  constructor() {
    super('Transcription stopped by user');
    this.name = 'TranscriptionStoppedError';
    this.stopped = true;
  }
}

export function isTranscriptionConfigured() {
  return !!(process.env.SARVAM_API_KEY || '').trim();
}

function apiKey() {
  const key = (process.env.SARVAM_API_KEY || '').trim();
  if (!key) {
    const err = new Error(
      'No Sarvam API key on this machine, so subtitles cannot be generated automatically. ' +
      'Add SARVAM_API_KEY to config.env next to Akashvani.exe, or upload an .srt yourself.'
    );
    err.notConfigured = true;
    throw err;
  }
  return key;
}

// ── ffmpeg helpers ──────────────────────────────────────────────────────────

/** Run ffmpeg/ffprobe and resolve with its stderr (where ffmpeg logs). */
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    liveProcs.add(proc);

    let killedByUs = false;
    const origKill = proc.kill.bind(proc);
    proc.kill = (...a) => { killedByUs = true; return origKill(...a); };

    let stderr = '';
    let stdout = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('data', (d) => { stdout += d.toString(); });

    proc.on('error', (err) => {
      liveProcs.delete(proc);
      reject(new Error(`Could not run ${bin}: ${err.message}`));
    });
    proc.on('close', (code) => {
      liveProcs.delete(proc);
      if (killedByUs) return reject(new TranscriptionStoppedError());
      if (code !== 0) return reject(new Error(`${bin} exited ${code}: ${stderr.slice(-1500)}`));
      resolve({ stderr, stdout });
    });
  });
}

/** Extract 16 kHz mono WAV and return its duration in seconds. */
async function extractAudio(video, outWav) {
  await run(FFMPEG_BIN, [
    '-y', '-i', video, '-vn', '-ac', '1', '-ar', '16000',
    '-c:a', 'pcm_s16le', outWav,
  ]);
  const { stdout } = await run(FFPROBE_BIN, [
    '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav,
  ]);
  const duration = parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not read the audio duration of ${video}`);
  }
  return duration;
}

/** Silence intervals as [[start, end], ...], via ffmpeg's silencedetect. */
export async function detectSilences(wav, noise = SILENCE_NOISE, minDuration = SILENCE_MIN) {
  const { stderr } = await run(FFMPEG_BIN, [
    '-i', wav,
    '-af', `silencedetect=noise=${noise}:d=${minDuration}`,
    '-f', 'null', '-',
  ]);
  const starts = [...stderr.matchAll(/silence_start:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));
  return starts.slice(0, Math.min(starts.length, ends.length))
    .map((s, i) => [s, ends[i]]);
}

/**
 * Speech segments are the complement of the silences: padded outwards, blips
 * dropped, close neighbours merged, and anything over the REST cap split.
 */
export function buildSegments(silences, total) {
  const segs = [];
  let cursor = 0;
  for (const [sStart, sEnd] of silences) {
    if (sStart > cursor) segs.push([cursor, sStart]);
    cursor = Math.max(cursor, sEnd);
  }
  if (cursor < total) segs.push([cursor, total]);

  // pad into the surrounding silence so word edges survive the cut
  for (const seg of segs) {
    seg[0] = Math.max(0, seg[0] - SEG_PAD);
    seg[1] = Math.min(total, seg[1] + SEG_PAD);
  }

  const kept = segs.filter(([s, e]) => e - s >= MIN_SEG);

  const merged = [];
  for (const seg of kept) {
    const last = merged[merged.length - 1];
    if (last && seg[0] - last[1] < MERGE_GAP && seg[1] - last[0] <= MERGE_MAX) {
      last[1] = seg[1];
    } else {
      merged.push([seg[0], seg[1]]);
    }
  }

  const final = [];
  for (const [start, end] of merged) {
    const dur = end - start;
    if (dur <= HARD_MAX) {
      final.push([start, end]);
      continue;
    }
    const n = Math.floor(dur / HARD_MAX) + 1;
    const step = dur / n;
    for (let i = 0; i < n; i++) final.push([start + i * step, start + (i + 1) * step]);
  }
  return final;
}

function cutSegment(wav, start, end, out) {
  return run(FFMPEG_BIN, [
    '-y', '-i', wav,
    '-ss', start.toFixed(3), '-to', end.toFixed(3),
    '-c:a', 'pcm_s16le', out,
  ]);
}

// ── Sarvam API ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Transcribe one segment, retrying on rate limits and server errors.
 *
 * `language` is locked rather than auto-detected: on sub-second utterances
 * auto-detect misfires badly — Hindi "अच्छा" has come back in Bengali or
 * Kannada script, which silently corrupts the subtitle file.
 */
async function transcribeSegment(path, key, language, model) {
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([await readFile(path)], { type: 'audio/wav' }), 'segment.wav');
      form.append('model', model);
      form.append('mode', MODE);
      if (language) form.append('language_code', language);

      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: { 'api-subscription-key': key },
        body: form,
        signal: AbortSignal.timeout(120000),
      });

      if (resp.ok) return await resp.json();

      const body = (await resp.text()).slice(0, 200);
      if (resp.status === 429) {
        lastErr = `HTTP 429: ${body}`;
        await sleep(5000 * attempt);       // rate limited — back off harder
        continue;
      }
      if ([500, 502, 503, 504].includes(resp.status)) {
        lastErr = `HTTP ${resp.status}: ${body}`;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      // 4xx other than 429 won't fix itself by retrying
      throw new Error(`HTTP ${resp.status}: ${body}`);
    } catch (err) {
      if (err.stopped) throw err;
      if (/^HTTP 4/.test(err.message)) throw err;
      lastErr = err.message;
      await sleep(2 ** attempt * 1000);
    }
  }
  throw new Error(`segment failed after ${MAX_RETRIES} retries: ${lastErr}`);
}

// ── cue building ────────────────────────────────────────────────────────────

// Devanagari danda plus western sentence enders.
const SENTENCE_SPLIT = /(?<=[।.?!])\s+/;
const CLAUSE_SPLIT = /(?<=[,;])\s+/;

/**
 * Hindi words that bind to the word BEFORE them — postpositions, auxiliaries
 * and case markers. Starting a cue with one of these reads as a broken phrase,
 * so a cut just before them is penalised.
 */
const BINDS_LEFT = new Set([
  'का', 'के', 'की', 'को', 'में', 'से', 'पर', 'ने', 'तक', 'लिए', 'द्वारा', 'साथ',
  'वाला', 'वाले', 'वाली', 'ही', 'भी', 'तो', 'है', 'हैं', 'था', 'थे', 'थी', 'हूँ',
  'हो', 'होगा', 'होगी', 'होंगे', 'गया', 'गई', 'गए', 'रहा', 'रही', 'रहे', 'कर',
  'करके', 'चुका', 'चुकी', 'सकता', 'सकती', 'सकते', 'नहीं',
]);

/**
 * Hindi words that bind to the word AFTER them — determiners, conjunctions and
 * quantifiers. Ending a cue on one of these leaves the phrase hanging.
 */
const BINDS_RIGHT = new Set([
  'और', 'या', 'कि', 'जो', 'लेकिन', 'परंतु', 'क्योंकि', 'इस', 'उस', 'यह', 'वह',
  'ये', 'वो', 'एक', 'अपने', 'अपनी', 'अपना', 'मेरे', 'मेरी', 'हमारे', 'हमारी',
  'बहुत', 'कुछ', 'हर', 'सभी', 'किसी', 'किस', 'जिस',
]);

const stripPunct = (w) => (w || '').replace(/[।,.?!;:"'()]/g, '');

/**
 * Choose where to cut a run of words that is over budget.
 *
 * Every space is a candidate. We prefer a cut that leaves balanced halves, and
 * penalise one that would strand a bound word at either edge. Without this the
 * splitter cut at the nearest space to the midpoint and produced breaks like
 * "...हम सबके | लिए विशेष महत्व रखता है।", which splits a noun from its
 * postposition.
 *
 * Returns the index of the space to cut at, or -1 if there is none.
 */
export function bestCut(text) {
  const spaces = [];
  for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) spaces.push(i);
  if (!spaces.length) return -1;

  const mid = text.length / 2;
  let best = -1;
  let bestScore = Infinity;
  for (const i of spaces) {
    const left = text.slice(0, i);
    const right = text.slice(i + 1);
    if (!left.trim() || !right.trim()) continue;

    // imbalance, normalised so it stays comparable to the penalties below
    let score = Math.abs(i - mid) / mid;
    const prev = stripPunct(left.split(' ').pop());
    const next = stripPunct(right.split(' ')[0]);
    if (BINDS_LEFT.has(next)) score += 1.0;   // cue would START with के/लिए/में...
    if (BINDS_RIGHT.has(prev)) score += 1.0;  // cue would END with इस/यह/और/कि...
    if (/[।.?!]$/.test(left)) score -= 0.6;   // sentence end: the best cut there is
    else if (/[,;:]$/.test(left)) score -= 0.3;

    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Break text into the smallest natural units: sentences, then clauses, then
 * phrase-aware halves for anything still over `budget`.
 *
 * `budget` is normally MAX_CUE_CHARS, but segmentToCues lowers it when the
 * segment is slow, so that a long quiet stretch produces several short cues
 * instead of one that sits on screen for nine seconds.
 */
export function splitUnits(text, budget = MAX_CUE_CHARS) {
  const limit = Math.max(1, budget);
  const units = [];
  for (const rawSent of text.split(SENTENCE_SPLIT)) {
    const sent = rawSent.trim();
    if (!sent) continue;
    const parts = sent.length <= limit ? [sent] : sent.split(CLAUSE_SPLIT);
    for (const rawPart of parts) {
      const part = rawPart.trim();
      if (!part) continue;
      // word-level fallback: halve at the best available space until it fits
      const stack = [part];
      while (stack.length) {
        const p = stack.shift();
        const cut = p.length <= limit ? -1 : bestCut(p);
        if (cut === -1) {
          units.push(p);
          continue;
        }
        stack.unshift(p.slice(0, cut).trim(), p.slice(cut + 1).trim());
      }
    }
  }
  return units;
}

function isJunk(text) {
  const stripped = text.toLowerCase().replace(/^[[\].।!?]+|[[\].।!?]+$/g, '');
  return JUNK_TRANSCRIPTS.has(stripped);
}

/**
 * Characters a cue may hold in this segment.
 *
 * Both ceilings have to bind at once, and the duration ceiling is a limit on
 * TIME, not text — so convert it to characters using this segment's own
 * speaking rate. A segment of 42 characters over 10 s runs at 0.24 s/char, so
 * 3.5 s of screen time is ~14 characters, and the segment becomes four cues
 * rather than one. MIN_CUE_CHARS stops a near-silent segment (little text,
 * lots of time) from being shredded a word at a time.
 */
function cueBudget(start, end, textLength) {
  const duration = end - start;
  if (!(duration > 0) || !textLength) return MAX_CUE_CHARS;
  const secPerChar = duration / textLength;
  const byDuration = Math.floor(MAX_CUE_DURATION / secPerChar);
  return Math.max(MIN_CUE_CHARS, Math.min(MAX_CUE_CHARS, byDuration));
}

/**
 * One speech segment becomes one or more cues.
 *
 * Short segments map 1:1, and their timing is exact — straight off the silence
 * boundaries. Anything over either ceiling is split into natural units and the
 * segment's duration shared out by character count, then each internal cut is
 * moved onto the nearest micro-pause in `pauses`, so the boundary lands where
 * the speaker actually stopped instead of where the character count guessed.
 * Without `pauses` the character estimate stands.
 */
export function segmentToCues(start, end, transcript, pauses = []) {
  const text = (transcript || '').trim();
  if (!text || isJunk(text)) return [];

  const budget = cueBudget(start, end, text.length);
  if (text.length <= budget) return [{ start, end, text }];

  const units = splitUnits(text, budget);

  // pack units back up into cue-sized pieces
  const pieces = [];
  let current = '';
  for (const unit of units) {
    const candidate = `${current} ${unit}`.trim();
    if (current && candidate.length > budget) {
      pieces.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);

  const totalChars = pieces.reduce((n, p) => n + p.length, 0);
  const duration = end - start;

  // Estimate each internal boundary by sharing the segment's duration out by
  // character count, then move it onto a real pause where there is one.
  const boundaries = [];
  let cursor = start;
  for (let i = 0; i < pieces.length - 1; i++) {
    cursor += (duration * pieces[i].length) / totalChars;
    boundaries.push(cursor);
  }
  const snapped = snapCuts(boundaries, midpointsWithin(pauses, start, end), start, end);

  return pieces.map((text, i) => ({
    start: i === 0 ? start : snapped[i - 1],
    end: i === pieces.length - 1 ? end : snapped[i],
    text,
  }));
}

/** Midpoints of the pauses that fall inside [lo, hi]. `pauses` is sorted. */
export function midpointsWithin(pauses, lo, hi) {
  const out = [];
  for (const [s, e] of pauses) {
    if (e <= lo) continue;
    if (s >= hi) break;
    out.push((Math.max(s, lo) + Math.min(e, hi)) / 2);
  }
  return out;
}

/**
 * Move each estimated cut onto the nearest real pause.
 *
 * A cut is only allowed to move so far: SNAP_WINDOW in absolute terms, and
 * never more than SNAP_FRACTION of the shorter side, so a cue can't be pulled
 * past its neighbour or collapsed to nothing. Cuts stay strictly increasing —
 * each one is placed after the one before it, so a snap can never reorder them.
 * With no pauses in range the estimate is kept, which is the old behaviour.
 */
export function snapCuts(cuts, pauseMids, lo, hi) {
  const out = [];
  for (let i = 0; i < cuts.length; i++) {
    const t = cuts[i];
    const prev = i === 0 ? lo : out[i - 1];
    const next = i === cuts.length - 1 ? hi : cuts[i + 1];
    const room = Math.min(t - prev, next - t);
    const allowance = Math.min(SNAP_WINDOW, Math.max(0, room) * SNAP_FRACTION);

    let best = t;
    let bestDist = allowance;
    for (const mid of pauseMids) {
      if (mid <= prev) continue;
      if (mid >= next) break;
      const dist = Math.abs(mid - t);
      if (dist <= bestDist) {
        bestDist = dist;
        best = mid;
      }
    }
    out.push(Math.min(Math.max(best, prev), next));
  }
  return out;
}

/** SRT timestamp with millisecond precision: HH:MM:SS,mmm */
export function fmtSrtTime(seconds) {
  const msTotal = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(msTotal / 3600000);
  const m = Math.floor((msTotal % 3600000) / 60000);
  const s = Math.floor((msTotal % 60000) / 1000);
  const ms = msTotal % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** Break a long cue into at most two balanced lines. */
function wrapTwoLines(text, width = MAX_CUE_CHARS) {
  if (text.length <= width) return text;
  const mid = Math.floor(text.length / 2);
  const left = text.lastIndexOf(' ', mid);
  const right = text.indexOf(' ', mid);
  const cut = left !== -1 && (right === -1 || mid - left <= right - mid) ? left : right;
  if (cut === -1) return text;
  return `${text.slice(0, cut)}\n${text.slice(cut + 1)}`;
}

/** Serialise cues to SRT text, enforcing readable durations and no overlaps. */
export function buildSrt(cues) {
  for (const cue of cues) {
    if (cue.end - cue.start < MIN_CUE_DURATION) cue.end = cue.start + MIN_CUE_DURATION;
  }
  // padding above can push a cue into the next one — clamp rather than overlap
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }

  const lines = [];
  cues.forEach((cue, i) => {
    lines.push(String(i + 1));
    lines.push(`${fmtSrtTime(cue.start)} --> ${fmtSrtTime(cue.end)}`);
    lines.push(wrapTwoLines(cue.text));
    lines.push('');
  });
  // CRLF throughout, including inside a two-line cue. Premiere Pro and the
  // Windows subtitle tools downstream expect it, and it makes the output
  // byte-identical to the prototype these cue rules were validated against.
  return lines.join('\n').replace(/\n/g, '\r\n');
}

// ── orchestration ───────────────────────────────────────────────────────────

/** Run `jobs` with at most `limit` in flight, preserving result order. */
async function pooled(jobs, limit, onSettled) {
  const results = new Array(jobs.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = await jobs[i]();
      } catch (err) {
        if (err.stopped) throw err;
        results[i] = null;
        onSettled?.(i, err);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Generate an SRT for one video.
 *
 * @param {string} videoPath
 * @param {string} outSrtPath
 * @param {object} opts
 * @param {(pct:number)=>void}   [opts.onProgress] 0-100
 * @param {(msg:string)=>void}   [opts.onLog]
 * @param {()=>void}             [opts.throwIfStopped] called at each boundary
 * @param {string}               [opts.model]
 * @param {string}               [opts.language] BCP-47, or 'unknown' to auto-detect
 * @param {string}               [opts.workDir]  scratch dir for segment WAVs
 * @returns {Promise<{srt: string, cues: number, segments: number, failed: number}>}
 */
export async function generateSrtForVideo(videoPath, outSrtPath, opts = {}) {
  const {
    onProgress = () => {},
    onLog = () => {},
    throwIfStopped = () => {},
    model = (process.env.SARVAM_MODEL || DEFAULT_MODEL).trim(),
    language = (process.env.SARVAM_LANGUAGE || DEFAULT_LANGUAGE).trim(),
    workDir = `${outSrtPath}.segments`,
  } = opts;

  const key = apiKey();
  const langLock = language === 'unknown' ? null : language;

  await mkdir(workDir, { recursive: true });
  const fullWav = join(workDir, 'full_audio.wav');

  try {
    throwIfStopped();
    onLog('Extracting audio (16 kHz mono)...');
    const total = await extractAudio(videoPath, fullWav);
    onLog(`Audio duration: ${total.toFixed(1)}s`);
    onProgress(10);

    throwIfStopped();
    onLog('Detecting silences to find phrase boundaries...');
    const silences = await detectSilences(fullWav);
    const segments = buildSegments(silences, total);
    if (!segments.length) {
      throw new Error('No speech found in this video — nothing to transcribe.');
    }

    // Second, much more sensitive pass. These are not segment boundaries and
    // are never sent to the API — they are the candidate cut points used when
    // a segment has to become more than one cue.
    const pauses = await detectSilences(fullWav, MICRO_NOISE, MICRO_MIN);
    onLog(`${segments.length} speech segments, ${pauses.length} micro-pauses for cue boundaries`);
    const speech = segments.reduce((n, [s, e]) => n + (e - s), 0);
    onLog(`${silences.length} silences → ${segments.length} speech segments (${Math.round(speech)}s of speech)`);
    onProgress(15);

    onLog(`Cutting ${segments.length} segment files...`);
    const segFiles = [];
    for (let i = 0; i < segments.length; i++) {
      throwIfStopped();
      const p = join(workDir, `seg_${String(i).padStart(4, '0')}.wav`);
      await cutSegment(fullWav, segments[i][0], segments[i][1], p);
      segFiles.push(p);
      if (i % 25 === 0) onProgress(15 + Math.round((i / segments.length) * 15));
    }
    onProgress(30);

    onLog(`Transcribing ${segments.length} segments with ${model} (${MAX_WORKERS} at a time)...`);
    let done = 0;
    const failures = [];
    const jobs = segFiles.map((file, i) => async () => {
      throwIfStopped();
      const payload = await transcribeSegment(file, key, langLock, model);
      done++;
      onProgress(30 + Math.round((done / segments.length) * 65));
      if (done % 10 === 0 || done === segments.length) {
        onLog(`  ${done}/${segments.length} segments transcribed`);
      }
      return payload;
    });

    const results = await pooled(jobs, MAX_WORKERS, (i, err) => {
      failures.push(i);
      logWarn('Sarvam segment failed', { index: i, error: err.message });
    });

    // Sequential retry for stragglers — these are nearly always rate-limit
    // casualties, and a second pass at one-at-a-time usually recovers them.
    if (failures.length) {
      onLog(`Retrying ${failures.length} failed segment(s) one at a time...`);
      await sleep(10000);
      for (const i of failures) {
        throwIfStopped();
        try {
          results[i] = await transcribeSegment(segFiles[i], key, langLock, model);
        } catch (err) {
          logWarn('Sarvam segment failed on retry', { index: i, error: err.message });
          onLog(`  segment ${i + 1} could not be transcribed — leaving a gap`);
        }
        await sleep(2000);
      }
    }

    if (results.every((r) => r === null)) {
      throw new Error(
        'Every segment failed to transcribe. Check the Sarvam API key and this machine\'s internet connection.'
      );
    }

    onLog('Building subtitle cues...');
    const cues = [];
    results.forEach((payload, i) => {
      if (!payload) return;
      cues.push(...segmentToCues(segments[i][0], segments[i][1], payload.transcript || '', pauses));
    });
    if (!cues.length) {
      throw new Error('Transcription returned no usable text for this video.');
    }

    const srt = buildSrt(cues);
    await writeFile(outSrtPath, srt, 'utf8');

    // Keep the raw responses next to the SRT. When a reviewer says a line is
    // wrong, this is the only way to tell a bad transcription apart from bad
    // cue shaping without paying to run the whole episode again.
    await writeFile(
      `${outSrtPath.replace(/\.srt$/i, '')}.raw.json`,
      JSON.stringify(segments.map(([s, e], i) => ({ start: s, end: e, response: results[i] })), null, 2),
      'utf8'
    );

    const stillFailed = results.filter((r) => r === null).length;
    onLog(`${cues.length} cues written${stillFailed ? ` (${stillFailed} segment(s) missing)` : ''}`);
    onProgress(100);

    logInfo('Sarvam transcription complete', {
      video: videoPath, cues: cues.length, segments: segments.length, failed: stillFailed, model,
    });

    return { srt, cues: cues.length, segments: segments.length, failed: stillFailed };
  } finally {
    // Segment WAVs are pure scratch and can run to hundreds of files.
    await rm(workDir, { recursive: true, force: true }).catch((err) => {
      logWarn('Could not clean up transcription scratch dir', { workDir, error: err.message });
    });
  }
}
