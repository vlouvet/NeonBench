import { describe, expect, it } from 'vitest';
import {
  adjustKernAtCaret,
  applyKey,
  caretMetrics,
  consumesKey,
  deleteBackward,
  deleteForward,
  insertText,
  isSessionEmpty,
  kernSlotAtCaret,
  moveCaret,
  seedKerning,
  sessionRuns,
  startSession,
  suppressesGlobalShortcut,
  typeString,
  visibleGlyphs,
  type InlineTextSession,
  type KeyEventLike,
} from './inlineTextState';
import { FONTS, getFont } from './hershey/fonts';
import { hersheyTextToRuns } from './hershey/text';

const DEFAULTS = { font: 'rowmans' as const, capHeightMM: 100, lineHeight: 1.2 };

function fresh(text = ''): InlineTextSession {
  return typeString(startSession(0, 0, DEFAULTS), text);
}

describe('startSession', () => {
  it('treats the click point as the BASELINE, not as JHF y=0', () => {
    // Bug #13's ghost: `originY` anchors JHF y=0, which sits
    // `baselineUnits * scale` ABOVE the baseline. Clicking at y=500 must
    // put the baseline at 500, so originY has to be pulled up.
    const font = getFont('rowmans');
    const s = startSession(10, 500, DEFAULTS);
    const scale = DEFAULTS.capHeightMM / font.capHeightUnits;
    expect(s.originY).toBeCloseTo(500 - font.baselineUnits * scale, 9);
    expect(caretMetrics(s).baselineY).toBeCloseTo(500, 9);
    // …and a capital reaches exactly capHeightMM above that baseline.
    expect(caretMetrics(s).capTopY).toBeCloseTo(500 - DEFAULTS.capHeightMM, 9);
  });
});

describe('text editing', () => {
  it('inserts at the caret and advances it', () => {
    const s = fresh('OPEN');
    expect(s.text).toBe('OPEN');
    expect(s.caret).toBe(4);
  });

  it('inserts in the middle without disturbing the tail', () => {
    let s = fresh('OEN');
    s = moveCaret(s, 'home');
    s = moveCaret(s, 'right');
    s = insertText(s, 'P');
    expect(s.text).toBe('OPEN');
    expect(s.caret).toBe(2);
  });

  it('backspace deletes before the caret, delete deletes after it', () => {
    let s = fresh('OPEN');
    s = deleteBackward(s);
    expect(s.text).toBe('OPE');
    s = moveCaret(s, 'home');
    s = deleteForward(s);
    expect(s.text).toBe('PE');
    expect(s.caret).toBe(0);
  });

  it('is a no-op at the ends', () => {
    const empty = fresh('');
    expect(deleteBackward(empty)).toBe(empty);
    expect(deleteForward(empty)).toBe(empty);
    expect(moveCaret(empty, 'left')).toBe(empty);
    expect(moveCaret(empty, 'right')).toBe(empty);
  });

  it('Enter starts a new line and the caret follows it', () => {
    const s = fresh('AB\nCD');
    expect(s.text).toBe('AB\nCD');
    expect(caretMetrics(s).lineIndex).toBe(1);
    // Second line's anchor sits capHeight * lineHeight below the first.
    expect(caretMetrics(s).anchorY).toBeCloseTo(
      s.originY + DEFAULTS.capHeightMM * DEFAULTS.lineHeight,
      9,
    );
  });

  it('Home / End clamp to the current line, not the whole text', () => {
    let s = fresh('AB\nCDE');
    s = moveCaret(s, 'home');
    expect(s.caret).toBe(3); // start of line 2
    s = moveCaret(s, 'end');
    expect(s.caret).toBe(6);
    s = moveCaret(s, 'up');
    expect(s.caret).toBe(2); // column 3 clamped to end of a 2-char line
    s = moveCaret(s, 'home');
    expect(s.caret).toBe(0);
    s = moveCaret(s, 'down');
    expect(s.caret).toBe(3);
  });

  it('reports emptiness by ink, not by string length', () => {
    expect(isSessionEmpty(fresh(''))).toBe(true);
    // Spaces and newlines advance the pen but emit no strokes.
    expect(isSessionEmpty(fresh('  \n '))).toBe(true);
    expect(isSessionEmpty(fresh('A'))).toBe(false);
  });
});

describe('caret geometry mirrors hersheyTextToRuns', () => {
  // The caret walk is a SECOND implementation of the engine's advance
  // rule, which is exactly the Go/TS-twin hazard CLAUDE.md warns about.
  // Pin it against the strokes the engine actually emits: rendering
  // glyph i on its own at the caret position the helper reports must
  // reproduce that glyph's points inside the full string, byte for byte.
  function assertGlyphLandsAtCaret(text: string) {
    const full = fresh(text);
    const runs = sessionRuns(full);
    const chars = Array.from(text);
    let glyphIndex = 0;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '\n') continue;
      const at = { ...full, caret: i };
      const m = caretMetrics(at);
      const mine = runs.filter((r) => r.glyphIndex === glyphIndex).map((r) => r.points);
      const solo = hersheyTextToRuns({
        text: ch,
        font: full.font,
        capHeightMM: full.capHeightMM,
        originX: m.x,
        originY: m.anchorY,
      }).map((r) => r.points);
      // Guard against a vacuous pass: a space emits no strokes, so both
      // sides would be `[]` and the comparison would prove nothing.
      if (ch !== ' ') expect(mine.length).toBeGreaterThan(0);
      expect(solo).toEqual(mine);
      glyphIndex++;
    }
  }

  it('places every glyph of a kerned word at its caret position', () => {
    // 'AV' and 'VA' are both in the preset table, so this string
    // exercises the kerning term in the walk rather than just advances.
    assertGlyphLandsAtCaret('AVA');
  });

  it('holds across spaces and line breaks', () => {
    assertGlyphLandsAtCaret('AB C\nDE');
  });

  it('drifts if the kerning term is dropped — negative control', () => {
    // Same assertion with the kerning zeroed out of the caret walk only:
    // it must FAIL, otherwise the check above is passing for free.
    const full = fresh('AVA');
    const runs = sessionRuns(full);
    const unkerned = { ...full, perPairKerningMM: [], caret: 1 };
    const m = caretMetrics(unkerned);
    const solo = hersheyTextToRuns({
      text: 'V',
      font: full.font,
      capHeightMM: full.capHeightMM,
      originX: m.x,
      originY: m.anchorY,
    }).map((r) => r.points);
    const mine = runs.filter((r) => r.glyphIndex === 1).map((r) => r.points);
    expect(full.perPairKerningMM[0]).not.toBe(0); // the preset really is non-zero
    expect(solo).not.toEqual(mine);
  });
});

describe('kerning agrees with the modal', () => {
  it('seeds a dense array of presets in the same index space', () => {
    // The modal's `applySeed` builds `visibleGlyphs - 1` entries and
    // fills untouched slots with `presetKerning[pair] * scale`. Assert
    // against the bundled font DATA rather than a copied constant
    // (CLAUDE.md bug class 6).
    const font = FONTS.rowmans;
    const scale = 100 / font.capHeightUnits;
    const seeded = seedKerning('AVA', 'rowmans', 100, [], []);
    expect(seeded.perPairKerningMM).toHaveLength(2);
    expect(seeded.perPairKerningMM[0]).toBeCloseTo(font.presetKerning['AV'] * scale, 9);
    expect(seeded.perPairKerningMM[1]).toBeCloseTo(font.presetKerning['VA'] * scale, 9);
    expect(seeded.kernTouched).toEqual([false, false]);
  });

  it('counts a space as a glyph, exactly as the engine does', () => {
    // ASCII 32 has left/right brackets and no strokes, so it occupies a
    // slot in `perPairKerningMM`. An editor that skipped it would write
    // every kern one slot to the left of the gap the operator sees.
    expect(visibleGlyphs('A B', 'rowmans')).toEqual(['A', ' ', 'B']);
    expect(seedKerning('A B', 'rowmans', 100, [], []).perPairKerningMM).toHaveLength(2);
  });

  it('keeps user-touched slots through a re-seed, drops the rest', () => {
    let s = fresh('AVA');
    s = { ...s, caret: 1 };
    s = adjustKernAtCaret(s, -7);
    const touchedValue = s.perPairKerningMM[0];
    s = insertText(s, 'X'); // text becomes 'AXVA' — re-seeds
    expect(s.perPairKerningMM[0]).toBeCloseTo(touchedValue, 9);
    expect(s.kernTouched[0]).toBe(true);
    expect(s.perPairKerningMM).toHaveLength(3);
  });

  it('writes the slot BEFORE the caret, and the geometry proves it', () => {
    let s = fresh('AVA');
    s = { ...s, caret: 1 }; // between A and V
    expect(kernSlotAtCaret(s)).toBe(0);
    const before = sessionRuns(s);
    const kerned = adjustKernAtCaret(s, -10);
    const after = sessionRuns(kerned);
    const xs = (runs: typeof before, gi: number) =>
      runs.filter((r) => r.glyphIndex === gi).flatMap((r) => r.points.map((p) => p[0]));
    // Glyph 0 does not move; glyphs 1 and 2 move left by exactly 10 mm.
    expect(Math.min(...xs(after, 0))).toBeCloseTo(Math.min(...xs(before, 0)), 9);
    expect(Math.min(...xs(after, 1))).toBeCloseTo(Math.min(...xs(before, 1)) - 10, 9);
    expect(Math.min(...xs(after, 2))).toBeCloseTo(Math.min(...xs(before, 2)) - 10, 9);
    // Negative control: the off-by-one you get by counting the glyph
    // AFTER the caret would leave glyph 1 where it was.
    const wrongSlot = {
      ...s,
      perPairKerningMM: s.perPairKerningMM.map((v, i) => (i === 1 ? v - 10 : v)),
    };
    expect(Math.min(...xs(sessionRuns(wrongSlot), 1))).toBeCloseTo(
      Math.min(...xs(before, 1)),
      9,
    );
  });

  it('has no slot at either end of the text', () => {
    const s = fresh('AV');
    expect(kernSlotAtCaret({ ...s, caret: 0 })).toBeNull();
    expect(kernSlotAtCaret({ ...s, caret: 2 })).toBeNull();
    expect(kernSlotAtCaret({ ...s, caret: 1 })).toBe(0);
    expect(kernSlotAtCaret(fresh('A'))).toBeNull();
  });

  it('clamps at the engine floor so the array cannot outrun the geometry', () => {
    let s = fresh('AV');
    s = { ...s, caret: 1 };
    for (let i = 0; i < 50; i++) s = adjustKernAtCaret(s, -50);
    expect(s.perPairKerningMM[0]).toBe(-DEFAULTS.capHeightMM);
  });

  it('hands the modal-shaped parameters to the one shared engine', () => {
    // The runs the canvas draws and commits are `hersheyTextToRuns` of
    // the session's own fields — the same call the dialog makes. No
    // second code path exists that could let the two disagree.
    let s = fresh('AVA');
    s = adjustKernAtCaret({ ...s, caret: 2 }, 4);
    expect(sessionRuns(s)).toEqual(
      hersheyTextToRuns({
        text: s.text,
        font: s.font,
        capHeightMM: s.capHeightMM,
        originX: s.originX,
        originY: s.originY,
        lineHeight: s.lineHeight,
        perPairKerningMM: s.perPairKerningMM,
        applyPresetKerning: false,
      }),
    );
  });
});

describe('Alt+Arrow kerning keys', () => {
  it('steps by a fraction of the cap height, coarser with Shift', () => {
    const s = { ...fresh('AV'), caret: 1 };
    const base = s.perPairKerningMM[0];
    const fine = applyKey(s, { key: 'ArrowRight', altKey: true });
    expect(fine.kind).toBe('update');
    if (fine.kind !== 'update') return;
    expect(fine.session.perPairKerningMM[0]).toBeCloseTo(base + 100 / 50, 9);
    const coarse = applyKey(s, { key: 'ArrowLeft', altKey: true, shiftKey: true });
    if (coarse.kind !== 'update') return;
    expect(coarse.session.perPairKerningMM[0]).toBeCloseTo(base - (100 / 50) * 5, 9);
  });

  it('does not move the caret', () => {
    const s = { ...fresh('AV'), caret: 1 };
    const r = applyKey(s, { key: 'ArrowLeft', altKey: true });
    if (r.kind !== 'update') throw new Error('expected update');
    expect(r.session.caret).toBe(1);
  });
});

describe('shortcut suppression', () => {
  // Every bare key the editor binds elsewhere. `o` and `c` switch tools
  // (EditorPage), `j` / `k` / `[` / `]` jump between validation issues
  // (EditorPage), Delete / Backspace delete the selected runs
  // (EditorPage) or the selected guideline (EditorCanvas), Escape
  // clears the selection (both). A live caret must own all of them.
  const bareKeys: KeyEventLike[] = [
    { key: 'o' },
    { key: 'c' },
    { key: 'j' },
    { key: 'k' },
    { key: '[' },
    { key: ']' },
    { key: ' ' },
    { key: 'Delete' },
    { key: 'Backspace' },
    { key: 'Escape' },
    { key: 'Enter' },
    { key: 'A', shiftKey: true },
  ];

  it('consumes every bare key the editor binds elsewhere', () => {
    for (const e of bareKeys) expect(consumesKey(e)).toBe(true);
  });

  it('leaves modifier combinations to the app', () => {
    expect(consumesKey({ key: 'z', metaKey: true })).toBe(false);
    expect(consumesKey({ key: 'z', ctrlKey: true })).toBe(false);
    expect(consumesKey({ key: 'a', metaKey: true })).toBe(false);
    expect(consumesKey({ key: 's', metaKey: true })).toBe(false);
    expect(consumesKey({ key: 'Tab' })).toBe(false);
    expect(consumesKey({ key: 'F5' })).toBe(false);
    expect(consumesKey({ key: 'Shift' })).toBe(false);
  });

  it('takes Alt+Arrow for kerning but no other Alt combination', () => {
    expect(consumesKey({ key: 'ArrowLeft', altKey: true })).toBe(true);
    expect(consumesKey({ key: 'ArrowUp', altKey: true })).toBe(false);
    expect(consumesKey({ key: 'o', altKey: true })).toBe(false);
  });

  it('suppresses nothing at all once the caret is gone', () => {
    // The restoration half of the rule: with no live caret every one of
    // those keys goes back to its owner.
    for (const e of bareKeys) expect(suppressesGlobalShortcut(false, e)).toBe(false);
    for (const e of bareKeys) expect(suppressesGlobalShortcut(true, e)).toBe(true);
  });

  it('ignores keys it does not consume instead of eating them', () => {
    const s = fresh('A');
    expect(applyKey(s, { key: 'z', metaKey: true })).toEqual({ kind: 'ignored' });
    expect(applyKey(s, { key: 'Tab' })).toEqual({ kind: 'ignored' });
  });
});

describe('commit semantics', () => {
  it('typing a whole word produces no commit until the operator ends it', () => {
    // This is what makes one Cmd+Z revert the word: keystrokes mutate a
    // local session only, and the doc is written exactly once, at
    // commit. Nothing here depends on how fast the operator types.
    let s = startSession(0, 0, DEFAULTS);
    let commits = 0;
    for (const ch of 'OPEN') {
      const r = applyKey(s, { key: ch });
      if (r.kind === 'commit') commits++;
      if (r.kind !== 'ignored') s = r.session;
    }
    expect(commits).toBe(0);
    expect(s.text).toBe('OPEN');
    const end = applyKey(s, { key: 'Escape' });
    expect(end.kind).toBe('commit');
    if (end.kind !== 'commit') return;
    // Escape COMMITS — it does not throw the word away.
    expect(end.session.text).toBe('OPEN');
    expect(sessionRuns(end.session).length).toBeGreaterThan(0);
  });

  it('commits the runs that were on screen, at the place they were typed', () => {
    const s = typeString(startSession(120, 400, DEFAULTS), 'AV');
    const runs = sessionRuns(s);
    const xs = runs.flatMap((r) => r.points.map((p) => p[0]));
    const ys = runs.flatMap((r) => r.points.map((p) => p[1]));
    // First glyph's left bracket sits at the click X…
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(120 - 1e-9);
    // …and the capitals sit one cap height above the clicked baseline.
    expect(Math.min(...ys)).toBeCloseTo(400 - DEFAULTS.capHeightMM, 6);
    expect(Math.max(...ys)).toBeCloseTo(400, 6);
  });
});
