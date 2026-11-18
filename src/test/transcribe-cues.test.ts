// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  buildSegments, segmentToCues, splitUnits, bestCut, snapCuts, midpointsWithin,
  fmtSrtTime, buildSrt,
} from '../../server/services/transcribe.js';

/**
 * The cue rules were tuned against a real episode in the Python prototype and
 * signed off on the output. This file pins the parts of that behaviour that are
 * pure logic, so the timing and splitting can't drift without someone noticing.
 *
 * Nothing here touches the network or ffmpeg.
 */

describe('silence → speech segments', () => {
  it('takes the complement of the silences and pads outwards', () => {
    // 10 s of audio, one silence from 4 s to 5 s.
    const segs = buildSegments([[4, 5]], 10);
    expect(segs).toHaveLength(2);
    // SEG_PAD widens each side by 0.10 s, clamped to the clip.
    expect(segs[0][0]).toBeCloseTo(0, 5);
    expect(segs[0][1]).toBeCloseTo(4.1, 5);
    expect(segs[1][0]).toBeCloseTo(4.9, 5);
    expect(segs[1][1]).toBeCloseTo(10, 5);
  });

  it('merges phrases separated by a very short pause', () => {
    // 0.1 s gap is under MERGE_GAP (0.30), and the result stays under MERGE_MAX.
    const segs = buildSegments([[1.0, 1.1]], 2);
    expect(segs).toHaveLength(1);
  });

  it('refuses to merge past MERGE_MAX, so a cue never grows unreadable', () => {
    // Two 4 s phrases with a 0.1 s gap: merging would make 8 s, over the 5 s cap.
    const segs = buildSegments([[4.0, 4.1]], 8);
    expect(segs).toHaveLength(2);
  });

  it('splits anything over the API length cap', () => {
    // 100 s of unbroken speech must come back in chunks the REST endpoint accepts.
    const segs = buildSegments([], 100);
    expect(segs.length).toBeGreaterThan(1);
    for (const [s, e] of segs) expect(e - s).toBeLessThanOrEqual(29.0);
  });

  it('drops blips too short to be speech', () => {
    // Leaves a 0.05 s sliver between two silences — below MIN_SEG (0.25).
    const segs = buildSegments([[0, 1], [1.05, 2]], 2);
    expect(segs.every(([s, e]) => e - s >= 0.25)).toBe(true);
  });
});

describe('transcript → cues', () => {
  it('keeps a short line as one cue on the measured segment times', () => {
    const cues = segmentToCues(1.5, 3.25, 'चंपा।');
    expect(cues).toEqual([{ start: 1.5, end: 3.25, text: 'चंपा।' }]);
  });

  it('drops the labels the model hallucinates over music', () => {
    expect(segmentToCues(0, 1, '[Music]')).toEqual([]);
    expect(segmentToCues(0, 1, 'संगीत')).toEqual([]);
    expect(segmentToCues(0, 1, '  ')).toEqual([]);
  });

  it('splits a long transcript and shares the segment duration by text length', () => {
    const long = 'यह पहला वाक्य है और यह काफ़ी लंबा है। यह दूसरा वाक्य है जो भी लंबा है।';
    const cues = segmentToCues(10, 20, long);

    expect(cues.length).toBeGreaterThan(1);
    // Cue timing must stay inside the segment the audio was actually cut from.
    expect(cues[0].start).toBe(10);
    expect(cues[cues.length - 1].end).toBe(20);
    // Contiguous, no gaps and no overlaps.
    for (let i = 0; i < cues.length - 1; i++) {
      expect(cues[i].end).toBeCloseTo(cues[i + 1].start, 9);
    }
    // No cue should be wider than a readable line.
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(35);
  });

  it('breaks a run-on phrase with no punctuation at word boundaries', () => {
    const units: string[] = splitUnits('a'.repeat(20) + ' ' + 'b'.repeat(20) + ' ' + 'c'.repeat(20));
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) expect(u.length).toBeLessThanOrEqual(35);
    // Nothing invented and nothing lost.
    expect(units.join(' ').replace(/\s+/g, '')).toBe(('a'.repeat(20) + 'b'.repeat(20) + 'c'.repeat(20)));
  });
});

/**
 * These pin the fix for the defect found by diffing our output against a
 * Premiere Pro caption of the same speech: we only ever limited cue LENGTH, so
 * a short line spoken slowly sat on screen for nine seconds. PP never exceeds
 * 35 characters or 3.36 s; neither should we.
 */
describe('cues are limited by time as well as by length', () => {
  it('splits a short line that would otherwise sit on screen for nine seconds', () => {
    // 36 characters over 9.13 s — the real cue that started this. Under the old
    // rule it fit in 42 chars, so it was emitted whole.
    const text = 'कारगिल ने एक बार फिर यह बता दिया है।';
    const cues = segmentToCues(1019.5, 1028.63, text);

    expect(cues.length).toBeGreaterThan(2);
    for (const c of cues) expect(c.end - c.start).toBeLessThanOrEqual(3.5 + 1e-6);
    // Still covers the segment exactly, and nothing is invented or lost.
    expect(cues[0].start).toBe(1019.5);
    expect(cues[cues.length - 1].end).toBe(1028.63);
    expect(cues.map((c) => c.text).join(' ')).toBe(text);
  });

  it('leaves a line alone when it fits both ceilings', () => {
    // 29 characters in 2.5 s: inside the length cap and inside the time cap,
    // so the duration rule must not split it for the sake of splitting.
    const text = 'कारगिल ने फिर यह बता दिया है।';
    expect(text.length).toBeLessThanOrEqual(35);
    expect(segmentToCues(10, 12.5, text)).toHaveLength(1);
  });

  it('splits that same line once it is stretched past the time cap', () => {
    const text = 'कारगिल ने फिर यह बता दिया है।';
    expect(segmentToCues(10, 20, text).length).toBeGreaterThan(1);
  });

  it('refuses to shred a near-silent segment word by word', () => {
    // Three words across 9 s is a merged-segment artefact, not slow speech.
    // MIN_CUE_CHARS keeps it whole rather than guessing three cue times.
    const cues = segmentToCues(0, 9, 'हम से हम से');
    expect(cues).toHaveLength(1);
  });
});

describe('where a run-on phrase is cut', () => {
  it('does not strand a postposition at the start of the next cue', () => {
    // The real break that prompted this: "...हम सबके | लिए विशेष महत्व रखता है।"
    // splits सबके from its postposition लिए. Cutting before लिए must lose to
    // any other candidate.
    const cut = bestCut('इस वर्ष यह दिन हम सबके लिए विशेष महत्व रखता है।');
    expect(cut).toBeGreaterThan(-1);
    const next = 'इस वर्ष यह दिन हम सबके लिए विशेष महत्व रखता है।'.slice(cut + 1).split(' ')[0];
    expect(next).not.toBe('लिए');
  });

  it('does not leave a conjunction dangling at the end of a cue', () => {
    const text = 'हमें शहीदों के परिवार वालों और घायल जवानों की मदद करनी है';
    const cut = bestCut(text);
    expect(text.slice(0, cut).split(' ').pop()).not.toBe('और');
  });

  it('prefers a sentence end over a balanced cut', () => {
    // The midpoint is inside the second sentence; the danda should win anyway.
    const text = 'यह छोटा है। अब यह दूसरा वाक्य बहुत लंबा चलता रहता है';
    expect(bestCut(text)).toBe(text.indexOf('।') + 1);
  });

  it('returns -1 for a single word, so an unsplittable cue is left whole', () => {
    expect(bestCut('शुभकामनाएं')).toBe(-1);
  });
});

/**
 * Cue cuts are estimated by character count, then moved onto a real pause.
 * Only ~11% of the pauses a reference caption cuts at are big enough to survive
 * segmentation, so these come from a second, much more sensitive ffmpeg pass
 * and are used for cue boundaries only — never for what gets sent to the API.
 */
describe('cue cuts snap to real pauses', () => {
  it('moves a cut onto a nearby pause', () => {
    // Estimate at 5.0, a real pause centred on 5.4.
    const snapped = snapCuts([5.0], [5.4], 0, 10);
    expect(snapped[0]).toBeCloseTo(5.4, 6);
  });

  it('keeps the estimate when the nearest pause is out of reach', () => {
    // 3 s away is far beyond SNAP_WINDOW.
    expect(snapCuts([5.0], [8.0], 0, 10)[0]).toBe(5.0);
  });

  it('keeps the estimate when there are no pauses at all', () => {
    expect(snapCuts([5.0], [], 0, 10)[0]).toBe(5.0);
  });

  it('picks the nearest of several candidates', () => {
    expect(snapCuts([5.0], [4.6, 5.15, 5.6], 0, 10)[0]).toBeCloseTo(5.15, 6);
  });

  it('keeps cuts in order and inside the segment', () => {
    const snapped = snapCuts([3, 6], [5.9, 6.05], 0, 9);
    expect(snapped[0]).toBeLessThan(snapped[1]);
    for (const t of snapped) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(9);
    }
  });

  it('will not pull a cut past its neighbour, however close the pause', () => {
    // A pause sitting right on top of the next cut must not swallow the cue
    // between them.
    const snapped = snapCuts([3, 3.2], [3.19], 0, 9);
    expect(snapped[0]).toBeLessThan(snapped[1]);
  });

  it('only counts pauses that fall inside the segment', () => {
    expect(midpointsWithin([[1, 2], [5, 6], [20, 21]], 4, 10)).toEqual([5.5]);
  });

  it('snapping shifts cue times but never changes the text', () => {
    const text = 'पहला वाक्य यहाँ है। दूसरा वाक्य यहाँ है। तीसरा वाक्य यहाँ है।';
    const plain = segmentToCues(0, 12, text);
    const snapped = segmentToCues(0, 12, text, [[3.9, 4.1], [7.9, 8.1]]);

    expect(snapped.map((c) => c.text)).toEqual(plain.map((c) => c.text));
    expect(snapped[0].start).toBe(0);
    expect(snapped[snapped.length - 1].end).toBe(12);
    // Contiguous, no gaps and no overlaps.
    for (let i = 0; i < snapped.length - 1; i++) {
      expect(snapped[i].end).toBeCloseTo(snapped[i + 1].start, 9);
    }
  });
});

describe('SRT output', () => {
  it('formats timestamps to the millisecond', () => {
    expect(fmtSrtTime(0)).toBe('00:00:00,000');
    expect(fmtSrtTime(1.5)).toBe('00:00:01,500');
    expect(fmtSrtTime(98.279)).toBe('00:01:38,279');
    expect(fmtSrtTime(3661.004)).toBe('01:01:01,004');
    expect(fmtSrtTime(-5)).toBe('00:00:00,000');
  });

  it('writes well-formed, CRLF-terminated SRT blocks', () => {
    const srt: string = buildSrt([
      { start: 1, end: 2.5, text: 'पहली पंक्ति' },
      { start: 3, end: 4, text: 'दूसरी पंक्ति' },
    ]);
    expect(srt).toContain('\r\n');
    const blocks = srt.trim().split('\r\n\r\n');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].split('\r\n')[0]).toBe('1');
    expect(blocks[0].split('\r\n')[1]).toBe('00:00:01,000 --> 00:00:02,500');
    expect(blocks[1].split('\r\n')[0]).toBe('2');
  });

  it('pads a cue too short to read', () => {
    // 0.1 s is below MIN_CUE_DURATION (0.5) — a player would flash it.
    const srt: string = buildSrt([{ start: 1, end: 1.1, text: 'हाँ' }]);
    expect(srt).toContain('00:00:01,000 --> 00:00:01,500');
  });

  it('clamps rather than overlaps when padding runs into the next cue', () => {
    // Padding the first cue to 0.5 s would push it past the second's start.
    const srt: string = buildSrt([
      { start: 1, end: 1.05, text: 'हाँ' },
      { start: 1.2, end: 2, text: 'ठीक' },
    ]);
    expect(srt).toContain('00:00:01,000 --> 00:00:01,200');
    // Overlapping cues make a player show two lines at once.
    expect(srt).not.toContain('00:00:01,000 --> 00:00:01,500');
  });
});
