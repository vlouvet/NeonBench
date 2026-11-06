import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DesignDoc, DesignRun } from '../api';
import { RACEWAY_DEFAULT_HEIGHT_MM } from '../api';
import {
  type Bbox,
  type CameraPreset,
  type GroupFilter,
  PREVIEW_CAMERA_CONFIG,
  bboxOfDoc,
  cameraPositionForPreset,
} from './cameraPresets';
import { racewayBoxes } from './raceways';

// Tier 3 #183 — the preview frames (and sizes the wall around) raceways as
// well as tubes. `bboxOfDoc` is the single input to the initial fit, every
// preset, the group-change reframe and the wall plane's size, so pinning it
// pins all four. (Node only: no WebGL, no DOM.)

function run(
  id: string,
  points: [number, number][],
  extra: Partial<DesignRun> = {},
): DesignRun {
  return { id, polyline: { points, closed: false }, ...extra };
}

/**
 * Letters span x 100..300, doc y 50..150. One raceway (guideline g1 at doc
 * y 100, so its top edge sits behind the letters) runs x 0..800 — four
 * times wider than the letters, which is the cropped case from the row.
 */
function wideRacewayDoc(over: Partial<DesignDoc> = {}): DesignDoc {
  return {
    version: 1,
    view_box_mm: [0, 0, 1000, 500],
    runs: [
      run('r1', [
        [100, 50],
        [300, 150],
      ], { raceway_id: 'g1' }),
    ],
    guidelines: [{ id: 'g1', kind: 'raceway', y_mm: 100 }],
    raceways: [{ id: 'g1', x_mm: 0, length_mm: 800, height_mm: 150 }],
    ...over,
  };
}

/**
 * `bboxOfDoc` exactly as it was on `main` before #183 — runs only. Frozen
 * here so "a doc with no raceways is unchanged" is a comparison against the
 * old behaviour, not against itself.
 */
function runsOnlyBboxBefore183(doc: DesignDoc | null, filter?: GroupFilter): Bbox {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const filterId = typeof filter === 'string' && filter.length > 0 ? filter : null;
  if (doc) {
    for (const r of doc.runs) {
      if (filterId !== null && r.group_id !== filterId) continue;
      for (const [x, y] of r.polyline.points) {
        const tx = x;
        const ty = -y;
        if (tx < min.x) min.x = tx;
        if (ty < min.y) min.y = ty;
        if (tx > max.x) max.x = tx;
        if (ty > max.y) max.y = ty;
      }
    }
  }
  if (!Number.isFinite(min.x)) {
    min.set(-100, -100, -0.5);
    max.set(100, 100, 0.5);
  } else {
    min.z = -0.5;
    max.z = 0.5;
  }
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(max, min).multiplyScalar(0.5);
  return { min, max, size, center };
}

const plain = (b: Bbox) => ({
  min: b.min.toArray(),
  max: b.max.toArray(),
  size: b.size.toArray(),
  center: b.center.toArray(),
});

/** XY rectangle of each box `racewayBoxes` would draw. */
function drawnRects(doc: DesignDoc, runs?: DesignRun[], focus: string | null = null) {
  return racewayBoxes(doc, runs, focus).map((b) => ({
    minX: b.position[0] - b.size[0] / 2,
    maxX: b.position[0] + b.size[0] / 2,
    minY: b.position[1] - b.size[1] / 2,
    maxY: b.position[1] + b.size[1] / 2,
  }));
}

/** The eight corners of every drawn raceway box, in world space. */
function drawnCorners(doc: DesignDoc): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const b of racewayBoxes(doc)) {
    for (const sx of [-0.5, 0.5])
      for (const sy of [-0.5, 0.5])
        for (const sz of [-0.5, 0.5])
          out.push(
            new THREE.Vector3(
              b.position[0] + sx * b.size[0],
              b.position[1] + sy * b.size[1],
              b.position[2] + sz * b.size[2],
            ),
          );
  }
  return out;
}

/**
 * Do these points all land inside the preview camera's view for `preset`?
 * Uses the real camera config (fov 50) at the render script's default
 * 1600×1200 viewport, which is the narrowest-FOV axis the PNG ships with.
 */
function allInView(bbox: Bbox, preset: CameraPreset, pts: THREE.Vector3[]): boolean {
  const { position, target } = cameraPositionForPreset(preset, bbox);
  const cam = new THREE.PerspectiveCamera(
    PREVIEW_CAMERA_CONFIG.fov,
    1600 / 1200,
    PREVIEW_CAMERA_CONFIG.near,
    PREVIEW_CAMERA_CONFIG.far,
  );
  cam.position.copy(position);
  // OrbitControls keeps +Y up; the top preset looks straight down it,
  // so give that one the same -Z up three's lookAt would degenerate on.
  if (preset === 'top') cam.up.set(0, 0, -1);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return pts.every((p) => {
    const n = p.clone().project(cam);
    return Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1 && n.z < 1;
  });
}

describe('bboxOfDoc — raceways (Tier 3 #183)', () => {
  it('widens to a raceway longer than the letters, at the drawn rectangle', () => {
    const doc = wideRacewayDoc();
    const bb = bboxOfDoc(doc);
    // X: the raceway's 0..800, not the letters' 100..300.
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(800, 9);
    // Y: raceway top edge at doc 100, bottom at 250 → three −100..−250;
    // letters reach up to doc 50 → three −50. Union −250..−50.
    expect(bb.min.y).toBeCloseTo(-250, 9);
    expect(bb.max.y).toBeCloseTo(-50, 9);
    // And the box it measured is the one Scene draws.
    const [r] = drawnRects(doc);
    expect(bb.min.x).toBeLessThanOrEqual(r.minX);
    expect(bb.max.x).toBeGreaterThanOrEqual(r.maxX);
    expect(bb.min.y).toBeLessThanOrEqual(r.minY);
    expect(bb.max.y).toBeGreaterThanOrEqual(r.maxY);
    // Negative control: the pre-#183 bbox did not contain it.
    const old = runsOnlyBboxBefore183(doc);
    expect(old.min.x).toBe(100);
    expect(old.max.x).toBe(300);
  });

  it('frames a raceway-only doc on the raceway, not the 200 mm fallback at the origin', () => {
    const doc = wideRacewayDoc({ runs: [] });
    const bb = bboxOfDoc(doc);
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(800, 9);
    expect(bb.min.y).toBeCloseTo(-250, 9);
    expect(bb.max.y).toBeCloseTo(-100, 9);
    expect(bb.center.x).toBeCloseTo(400, 9);
    expect(bb.center.y).toBeCloseTo(-175, 9);
    // Negative control: before #183 this was the fallback cube.
    expect(plain(runsOnlyBboxBefore183(doc)).center).toEqual([0, 0, 0]);
  });

  it('uses the shop-default height for a 0 / absent height, like the drawn box', () => {
    for (const rw of [
      { id: 'g1', x_mm: 0, length_mm: 500 },
      { id: 'g1', x_mm: 0, length_mm: 500, height_mm: 0 },
    ]) {
      const bb = bboxOfDoc(wideRacewayDoc({ runs: [], raceways: [rw] }));
      expect(bb.max.y).toBeCloseTo(-100, 9);
      expect(bb.min.y).toBeCloseTo(-100 - RACEWAY_DEFAULT_HEIGHT_MM, 9);
    }
  });

  it('ignores raceway depth: Z stays the ±0.5 mm pad (depth is row 182)', () => {
    const bb = bboxOfDoc(wideRacewayDoc({ runs: [] }));
    expect(bb.min.z).toBe(-0.5);
    expect(bb.max.z).toBe(0.5);
  });

  it('puts every corner of a wide raceway in frame at every preset', () => {
    // The outcome the row is about. Front-face and back-face corners both,
    // so the 203 mm depth does not push the box out at iso/top/side.
    for (const doc of [wideRacewayDoc(), wideRacewayDoc({ runs: [] })]) {
      const corners = drawnCorners(doc);
      const bb = bboxOfDoc(doc);
      for (const preset of ['front', 'iso', 'top', 'side'] as const) {
        expect(allInView(bb, preset, corners), preset).toBe(true);
      }
    }
    // Negative control: framed on the letters alone, the raceway is cropped.
    expect(
      allInView(runsOnlyBboxBefore183(wideRacewayDoc()), 'front', drawnCorners(wideRacewayDoc())),
    ).toBe(false);
  });

  it('sizes the wall past the raceway (wall = 1.5 × bbox)', async () => {
    const { WALL_SIZE_FACTOR } = await import('./Scene');
    const bb = bboxOfDoc(wideRacewayDoc());
    expect(bb.size.x * WALL_SIZE_FACTOR).toBeGreaterThan(800);
    expect(bb.size.y * WALL_SIZE_FACTOR).toBeGreaterThan(150);
  });
});

describe('bboxOfDoc — a doc with no drawn raceway is unchanged (Tier 3 #183)', () => {
  const letters = wideRacewayDoc().runs;
  const grouped: DesignRun[] = [
    run('a', [
      [0, 0],
      [100, 0],
    ], { group_id: 'A' }),
    run('b', [
      [500, 500],
      [1000, 1000],
    ], { group_id: 'B' }),
  ];
  const cases: [string, DesignDoc | null][] = [
    ['null doc', null],
    ['empty doc', { version: 1, view_box_mm: [0, 0, 1, 1], runs: [] }],
    ['raceways field absent', { version: 1, view_box_mm: [0, 0, 1, 1], runs: letters }],
    ['raceways: []', wideRacewayDoc({ raceways: [] })],
    ['raceway with no guideline', wideRacewayDoc({ guidelines: [] })],
    [
      'raceway whose guideline is not a raceway guide',
      wideRacewayDoc({ guidelines: [{ id: 'g1', kind: 'construction', y_mm: 100 }] }),
    ],
    [
      'raceway with zero length',
      wideRacewayDoc({ raceways: [{ id: 'g1', x_mm: 0, length_mm: 0 }] }),
    ],
    ['grouped, no raceways', { version: 1, view_box_mm: [0, 0, 1, 1], runs: grouped }],
  ];

  for (const [name, doc] of cases) {
    it(`${name}: identical to the pre-#183 bbox, for every filter`, () => {
      for (const filter of [undefined, null, '', 'A', 'B', 'nonexistent']) {
        expect(plain(bboxOfDoc(doc, filter))).toEqual(
          plain(runsOnlyBboxBefore183(doc, filter)),
        );
      }
    });
  }

  it('negative control: a drawn raceway does change it', () => {
    const doc = wideRacewayDoc();
    expect(plain(bboxOfDoc(doc))).not.toEqual(plain(runsOnlyBboxBefore183(doc)));
  });
});

describe('bboxOfDoc — raceways under a group focus (Tier 3 #63 × #183)', () => {
  // Group A's letters sit on raceway gA (x 0..900); group B's letters are on
  // no raceway; an ungrouped run sits on gU (x −500..−100); gX carries
  // nobody's letters (x 2000..2500).
  const doc: DesignDoc = {
    version: 1,
    view_box_mm: [0, 0, 3000, 1000],
    runs: [
      run('a', [
        [400, 100],
        [500, 120],
      ], { group_id: 'A', raceway_id: 'gA' }),
      run('b', [
        [400, 600],
        [500, 620],
      ], { group_id: 'B' }),
      run('u', [
        [-300, 100],
        [-200, 120],
      ], { raceway_id: 'gU' }),
    ],
    groups: [
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
    ],
    guidelines: [
      { id: 'gA', kind: 'raceway', y_mm: 110 },
      { id: 'gU', kind: 'raceway', y_mm: 110 },
      { id: 'gX', kind: 'raceway', y_mm: 800 },
    ],
    raceways: [
      { id: 'gA', x_mm: 0, length_mm: 900, height_mm: 100 },
      { id: 'gU', x_mm: -500, length_mm: 400, height_mm: 100 },
      { id: 'gX', x_mm: 2000, length_mm: 500, height_mm: 100 },
    ],
  };

  it("includes the whole raceway a focused group's letters are mounted on", () => {
    const bb = bboxOfDoc(doc, 'A');
    // gA's full 0..900, not just group A's letters at 400..500.
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(900, 9);
    // gA hangs from doc 110 to 210 → three −110..−210; letters at −100..−120.
    expect(bb.min.y).toBeCloseTo(-210, 9);
    expect(bb.max.y).toBeCloseTo(-100, 9);
  });

  it('excludes raceways that carry none of the focused group (other groups, ungrouped, empty)', () => {
    // Group B is on no raceway: its bbox is its letters alone, exactly as before.
    expect(plain(bboxOfDoc(doc, 'B'))).toEqual(plain(runsOnlyBboxBefore183(doc, 'B')));
    // gU (ungrouped letters) and gX (no letters) never join group A's frame.
    const bb = bboxOfDoc(doc, 'A');
    expect(bb.min.x).toBeGreaterThanOrEqual(0);
    expect(bb.max.x).toBeLessThan(2000);
  });

  it('frames exactly the raceways Scene draws under the same focus', () => {
    for (const focus of ['A', 'B']) {
      const groupRuns = doc.runs.filter((r) => r.group_id === focus);
      const drawn = new Set(racewayBoxes(doc, groupRuns, focus).map((b) => b.id));
      expect([...drawn]).toEqual(focus === 'A' ? ['gA'] : []);
    }
  });

  it('with no focus, frames every drawn raceway, including one with no letters', () => {
    const bb = bboxOfDoc(doc);
    expect(bb.min.x).toBeCloseTo(-500, 9); // gU
    expect(bb.max.x).toBeCloseTo(2500, 9); // gX
    expect(bb.min.y).toBeCloseTo(-900, 9); // gX hangs doc 800..900
  });
});
