import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import { RACEWAY_DEFAULT_DEPTH_MM, RACEWAY_DEFAULT_HEIGHT_MM } from '../api';
import {
  RACEWAY_FRONT_GAP_MM,
  RACEWAY_WALL_CLEARANCE_MM,
  WALL_Z_OFFSET_MM,
  filterVisibleRuns,
  racewayBoxes,
} from './Scene';

// Tier 3 #138 — raceway boxes in the 3D preview.
//
// `racewayBoxes` is the whole geometry decision: doc raceway → box centre and
// extents in three.js world space. Scene meshes exactly what it returns and
// adds nothing when it returns `[]`, so pinning the helper pins the scene.
// (No WebGL here — web/ has no DOM test environment, deliberately.)

function makeRun(id: string, groupId?: string, racewayId?: string): DesignRun {
  return {
    id,
    polyline: {
      points: [
        [0, 0],
        [10, 0],
      ],
      closed: false,
    },
    group_id: groupId,
    raceway_id: racewayId,
  };
}

function racewayDoc(over: Partial<DesignDoc> = {}): DesignDoc {
  return {
    version: 1,
    view_box_mm: [0, 0, 1000, 500],
    runs: [makeRun('r1', undefined, 'g1'), makeRun('r2', 'A', 'g1')],
    groups: [
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
    ],
    guidelines: [{ id: 'g1', kind: 'raceway', y_mm: 100 }],
    raceways: [
      { id: 'g1', x_mm: 50, length_mm: 800, height_mm: 150, depth_mm: 120 },
    ],
    ...over,
  };
}

const front = (b: { position: number[]; size: number[] }) =>
  b.position[2] + b.size[2] / 2;
const back = (b: { position: number[]; size: number[] }) =>
  b.position[2] - b.size[2] / 2;

describe('racewayBoxes — geometry', () => {
  it('turns a doc raceway into a box at its own dimensions', () => {
    const boxes = racewayBoxes(racewayDoc());
    expect(boxes).toHaveLength(1);
    const [box] = boxes;
    expect(box.id).toBe('g1');
    // X: left edge 50, length 800 → centre 450.
    // Y: the guideline is the TOP edge (doc y 100, Y down); the box hangs
    //    150 below it → doc centre 175 → three Y −175.
    // Z: front face at −RACEWAY_FRONT_GAP_MM, 120 deep.
    expect(box.size).toEqual([800, 150, 120]);
    expect(box.position).toEqual([450, -175, -RACEWAY_FRONT_GAP_MM - 60]);
  });

  it('puts the top edge on the guideline and the box below it', () => {
    const [box] = racewayBoxes(racewayDoc());
    const top = box.position[1] + box.size[1] / 2;
    const bottom = box.position[1] - box.size[1] / 2;
    expect(top).toBe(-100); // doc y_mm 100, flipped like the tubes
    expect(bottom).toBe(-250); // 150 further DOWN the sign
  });

  it('resolves 0 / absent height and depth to the shop defaults', () => {
    for (const rw of [
      { id: 'g1', x_mm: 0, length_mm: 500 },
      { id: 'g1', x_mm: 0, length_mm: 500, height_mm: 0, depth_mm: 0 },
    ]) {
      const [box] = racewayBoxes(racewayDoc({ raceways: [rw] }));
      expect(box.size).toEqual([
        500,
        RACEWAY_DEFAULT_HEIGHT_MM,
        RACEWAY_DEFAULT_DEPTH_MM,
      ]);
    }
  });

  it('skips a raceway the editor would also skip', () => {
    // No matching RACEWAY guideline (a construction guide with the id does
    // not count).
    expect(
      racewayBoxes(
        racewayDoc({ guidelines: [{ id: 'g1', kind: 'construction', y_mm: 100 }] }),
      ),
    ).toEqual([]);
    expect(racewayBoxes(racewayDoc({ guidelines: [] }))).toEqual([]);
    // Zero / negative / non-finite length.
    for (const length_mm of [0, -10, Number.NaN]) {
      expect(
        racewayBoxes(racewayDoc({ raceways: [{ id: 'g1', x_mm: 0, length_mm }] })),
      ).toEqual([]);
    }
  });

  it('emits one box per raceway, in doc order', () => {
    const doc = racewayDoc({
      guidelines: [
        { id: 'g1', kind: 'raceway', y_mm: 100 },
        { id: 'g2', kind: 'raceway', y_mm: 400 },
      ],
      raceways: [
        { id: 'g2', x_mm: 0, length_mm: 300 },
        { id: 'g1', x_mm: 0, length_mm: 300 },
      ],
    });
    const boxes = racewayBoxes(doc);
    expect(boxes.map((b) => b.id)).toEqual(['g2', 'g1']);
    expect(boxes[0].position[1] + boxes[0].size[1] / 2).toBe(-400);
  });
});

describe('racewayBoxes — Z ordering against glass and wall', () => {
  it('keeps the front face behind the glass and in front of the wall', () => {
    // A 25 mm tube — fatter than anything a shop bends — has its back at
    // Z = −12.5; the wall plane is at −WALL_Z_OFFSET_MM.
    expect(RACEWAY_FRONT_GAP_MM).toBeGreaterThan(12.5);
    expect(RACEWAY_FRONT_GAP_MM).toBeLessThan(WALL_Z_OFFSET_MM);
    expect(WALL_Z_OFFSET_MM).toBe(50); // the spec forbids moving it
    const [box] = racewayBoxes(racewayDoc());
    expect(front(box)).toBe(-RACEWAY_FRONT_GAP_MM);
  });

  it('never puts the back face co-planar with the wall plane', () => {
    // The only co-planar case: depth == wall offset − front gap (30 mm).
    const coplanar = WALL_Z_OFFSET_MM - RACEWAY_FRONT_GAP_MM;
    for (const depth_mm of [coplanar - 0.2, coplanar, coplanar + 0.3]) {
      const [box] = racewayBoxes(
        racewayDoc({ raceways: [{ id: 'g1', x_mm: 0, length_mm: 100, depth_mm }] }),
      );
      expect(Math.abs(back(box) + WALL_Z_OFFSET_MM)).toBeGreaterThanOrEqual(
        RACEWAY_WALL_CLEARANCE_MM,
      );
      // ...pushed BEHIND the wall, where the wall hides the extra depth,
      expect(back(box)).toBeLessThan(-WALL_Z_OFFSET_MM);
      // ...and the front face never moves.
      expect(front(box)).toBe(-RACEWAY_FRONT_GAP_MM);
    }
    // Away from the wall the doc's depth is untouched.
    for (const depth_mm of [coplanar - 1, coplanar + 1, 203.2]) {
      const [box] = racewayBoxes(
        racewayDoc({ raceways: [{ id: 'g1', x_mm: 0, length_mm: 100, depth_mm }] }),
      );
      expect(box.size[2]).toBeCloseTo(depth_mm, 9);
    }
  });
});

describe('racewayBoxes — a no-raceway doc is unchanged', () => {
  it('builds nothing for a doc without raceways', () => {
    // Pre-#104 docs omit the field; later docs may carry `[]`. Scene renders
    // `<RacewayMeshes>` only when this is non-empty, so either way the
    // scene graph is exactly the pre-#138 one.
    const base = racewayDoc();
    const noField: DesignDoc = { ...base };
    delete noField.raceways;
    expect(racewayBoxes(noField)).toEqual([]);
    expect(racewayBoxes({ ...base, raceways: [] })).toEqual([]);
    expect(racewayBoxes(null)).toEqual([]);
    expect(racewayBoxes(undefined)).toEqual([]);
    // Negative control: the same doc WITH its raceway builds a box, so the
    // empty results above are a property of the input, not of a helper that
    // never returns anything.
    expect(racewayBoxes(base)).toHaveLength(1);
  });

  it('does not mutate the doc or change which runs Scene draws', () => {
    const doc = racewayDoc();
    const before = JSON.stringify(doc);
    racewayBoxes(doc);
    expect(JSON.stringify(doc)).toBe(before);
    expect(filterVisibleRuns(doc.runs, doc.groups, null)).toHaveLength(2);
  });
});

describe('racewayBoxes — group focus', () => {
  it('draws every raceway when no group is focused', () => {
    expect(racewayBoxes(racewayDoc(), [], null)).toHaveLength(1);
  });

  it('draws a raceway only if a focused, visible run belongs to it', () => {
    const doc = racewayDoc();
    const focusA = filterVisibleRuns(doc.runs, doc.groups, 'A');
    expect(racewayBoxes(doc, focusA, 'A')).toHaveLength(1);
    const focusB = filterVisibleRuns(doc.runs, doc.groups, 'B');
    expect(focusB).toEqual([]);
    expect(racewayBoxes(doc, focusB, 'B')).toEqual([]);
  });
});
