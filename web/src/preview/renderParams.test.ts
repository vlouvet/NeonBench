import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_PRESETS,
  BACKGROUND_SWATCH_VALUES,
  NO_BLOOM_RE,
  WALL_PRESETS,
  WALL_SWATCH_VALUES,
  applyRenderParams,
  parseRenderParams,
} from './renderParams';
import { DEFAULT_SCENE_CONTROLS } from './SceneControls';
import { CAMERA_PRESET_NAMES, isCameraPreset } from './cameraPresets';

// Tier 3 #137 — the URL contract for the preview route. This is what a
// driver (or a person sharing a link) types, so it has to mean the same
// thing on every machine.

describe('named scene values match the picker they claim to mirror', () => {
  // CLAUDE.md bug class #6: a constant that claims to describe other
  // data has to be asserted against that data. `wall=steel` promising a
  // colour that is no longer one of the swatches would be a silent
  // divergence between the URL and the UI.
  it('every named wall colour is a real wall swatch', () => {
    for (const [name, preset] of Object.entries(WALL_PRESETS)) {
      if (!preset.color) continue;
      expect(
        WALL_SWATCH_VALUES,
        `wall preset "${name}" points at a colour the picker no longer offers`,
      ).toContain(preset.color);
    }
  });

  it('every named background is a real background swatch', () => {
    for (const [name, hex] of Object.entries(BACKGROUND_PRESETS)) {
      expect(
        BACKGROUND_SWATCH_VALUES,
        `background preset "${name}" points at a colour the picker no longer offers`,
      ).toContain(hex);
    }
  });

  it('`off` is the only wall preset that hides the wall', () => {
    expect(WALL_PRESETS.off.enabled).toBe(false);
    for (const [name, preset] of Object.entries(WALL_PRESETS)) {
      if (name === 'off') continue;
      expect(preset.enabled).toBe(true);
    }
  });
});

describe('camera preset names', () => {
  // Guards the enum-widening trap: `CAMERA_PRESET_NAMES` is generated
  // from a `Record<CameraPreset, true>`, so this stays in step with the
  // union by construction — this test pins that it has not been
  // hand-edited into a stale literal list.
  it('covers exactly the four shipped views', () => {
    expect([...CAMERA_PRESET_NAMES].sort()).toEqual([
      'front',
      'iso',
      'side',
      'top',
    ]);
  });

  it('narrows only real preset names', () => {
    expect(isCameraPreset('iso')).toBe(true);
    expect(isCameraPreset('isometric')).toBe(false);
    expect(isCameraPreset('toString')).toBe(false);
  });
});

describe('parseRenderParams', () => {
  it('reads the shape the proof pipeline needs', () => {
    const p = parseRenderParams('?preset=iso&wall=steel&bg=black&autocapture=1');
    expect(p.preset).toBe('iso');
    expect(p.overrides.wallEnabled).toBe(true);
    expect(p.overrides.wallColor).toBe('#888888');
    expect(p.overrides.backgroundColor).toBe('#000000');
    expect(p.autocapture).toBe(true);
    expect(p.warnings).toEqual([]);
  });

  it('works with or without the leading question mark', () => {
    expect(parseRenderParams('preset=top').preset).toBe('top');
    expect(parseRenderParams('?preset=top').preset).toBe('top');
  });

  it('leaves everything alone when nothing is named', () => {
    const p = parseRenderParams('');
    expect(p.preset).toBeNull();
    expect(p.overrides).toEqual({});
    expect(p.autocapture).toBe(false);
    expect(p.noBloom).toBe(false);
    expect(p.warnings).toEqual([]);
  });

  it('accepts a raw hex wall and turns the wall on', () => {
    // Asking for a wall colour and getting no wall would be a surprise.
    const p = parseRenderParams('?wall=%23123456');
    expect(p.overrides.wallEnabled).toBe(true);
    expect(p.overrides.wallColor).toBe('#123456');
  });

  it('turns the wall off for wall=off without touching its colour', () => {
    const p = parseRenderParams('?wall=off');
    expect(p.overrides.wallEnabled).toBe(false);
    expect(p.overrides.wallColor).toBeUndefined();
  });

  it('is case-insensitive about names', () => {
    const p = parseRenderParams('?preset=ISO&wall=Steel&bg=DARK');
    expect(p.preset).toBe('iso');
    expect(p.overrides.wallColor).toBe('#888888');
    expect(p.overrides.backgroundColor).toBe('#1a1a1a');
  });

  // A typo must not quietly render the default and hand back a file
  // that looks fine. "It returned a PNG, so it worked" is the same trap
  // as "it returned 200, so it worked" (CLAUDE.md bug class #2).
  it('warns rather than silently defaulting on an unknown value', () => {
    const p = parseRenderParams('?preset=izo&wall=steal&bg=purpel');
    expect(p.preset).toBeNull();
    expect(p.overrides).toEqual({});
    expect(p.warnings).toHaveLength(3);
    expect(p.warnings.join(' ')).toMatch(/izo/);
    expect(p.warnings.join(' ')).toMatch(/steal/);
    expect(p.warnings.join(' ')).toMatch(/purpel/);
  });

  it('ignores unknown keys so older drivers keep working', () => {
    const p = parseRenderParams('?groupId=g1&preset=side&somethingNew=7');
    expect(p.preset).toBe('side');
    expect(p.warnings).toEqual([]);
  });

  it('treats autocapture=0 as off', () => {
    expect(parseRenderParams('?autocapture=0').autocapture).toBe(false);
    expect(parseRenderParams('?autocapture').autocapture).toBe(true);
    expect(parseRenderParams('?autocapture=1').autocapture).toBe(true);
  });

  it('reads a positive timeout and rejects a nonsense one', () => {
    expect(parseRenderParams('?timeout=45000').timeoutMs).toBe(45000);
    const bad = parseRenderParams('?timeout=-1');
    expect(bad.timeoutMs).toBeNull();
    expect(bad.warnings).toHaveLength(1);
  });

  describe('nobloom detection', () => {
    // Scene.tsx reads `?nobloom` straight off `window.location.search`
    // with its own copy of this regex, outside React Router. If the two
    // disagreed, the page would install a bloom-expecting capture guard
    // over a scene rendering without a composer and the headless render
    // would fail with a confusing message. Same inputs, same answer.
    const cases: [string, boolean][] = [
      ['?nobloom', true],
      ['?nobloom=1', true],
      ['?preset=iso&nobloom', true],
      ['?nobloom&preset=iso', true],
      ['?preset=iso', false],
      ['?notnobloom=1', false],
      ['', false],
    ];
    for (const [search, expected] of cases) {
      it(`${search || '(empty)'} → ${expected}`, () => {
        expect(parseRenderParams(search).noBloom).toBe(expected);
        expect(NO_BLOOM_RE.test(search.startsWith('?') ? search : `?${search}`)).toBe(
          expected,
        );
      });
    }
  });
});

describe('applyRenderParams', () => {
  it('overrides only the fields the URL named', () => {
    const base = { ...DEFAULT_SCENE_CONTROLS, ambientIntensity: 0.9 };
    const next = applyRenderParams(base, parseRenderParams('?wall=wood'));
    expect(next.wallEnabled).toBe(true);
    expect(next.wallColor).toBe('#8a6a3a');
    // Untouched fields fall through to the caller's saved feel.
    expect(next.ambientIntensity).toBe(0.9);
    expect(next.backgroundColor).toBe(base.backgroundColor);
  });

  // The determinism property the proof pipeline depends on: the same URL
  // must produce the same image on a machine with different persisted
  // scene prefs. If prefs won, two shops would get two different proofs
  // from one link.
  it('beats the persisted prefs it is layered over', () => {
    const persisted = {
      ...DEFAULT_SCENE_CONTROLS,
      backgroundColor: '#ffffff',
      wallEnabled: true,
      wallColor: '#8a6a3a',
    };
    const next = applyRenderParams(
      persisted,
      parseRenderParams('?bg=black&wall=off'),
    );
    expect(next.backgroundColor).toBe('#000000');
    expect(next.wallEnabled).toBe(false);
  });

  it('does not mutate the base state', () => {
    const base = { ...DEFAULT_SCENE_CONTROLS };
    const snapshot = { ...base };
    applyRenderParams(base, parseRenderParams('?bg=white'));
    expect(base).toEqual(snapshot);
  });
});
