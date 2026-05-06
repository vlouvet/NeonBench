// Pure functions that drive the editor's doc mutations. Extracting them
// here from EditorPage lets unit tests exercise each transformation
// without spinning up React or the canvas, and lets EditorPage stay
// focused on UI plumbing.
//
// Every op takes a DesignDoc and returns a NEW DesignDoc — the existing
// editDoc() wrapper in EditorPage handles undo-stack push and dirty flag.

import type {
  Annotation,
  Bend,
  Blockout,
  DesignDoc,
  DesignRun,
  Dimension,
  Label,
} from '../api';
import { computeBends, type BendPoint } from './bends';
import { defaultDirection } from './runArcs';

type Electrode = { point_index: number };

function mapRun(doc: DesignDoc, runId: string, fn: (run: DesignRun) => DesignRun): DesignDoc {
  return { ...doc, runs: doc.runs.map((r) => (r.id === runId ? fn(r) : r)) };
}

export function placeElectrode(doc: DesignDoc, runId: string, pointIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const existing = run.electrodes ?? [];
    let next: Electrode[];
    if (existing.length >= 2) {
      const dist = (idx: number) => Math.abs(idx - pointIndex);
      const replaceIdx = dist(existing[0].point_index) < dist(existing[1].point_index) ? 0 : 1;
      next = existing.slice();
      next[replaceIdx] = { point_index: pointIndex };
    } else {
      next = [...existing, { point_index: pointIndex }];
    }
    const updated: DesignRun = { ...run, electrodes: next };
    if (run.polyline.closed && next.length === 2 && !run.direction) {
      updated.direction = defaultDirection(updated);
    }
    return updated;
  });
}

export function deleteElectrode(doc: DesignDoc, runId: string, electrodeIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    electrodes: (run.electrodes ?? []).filter((_, i) => i !== electrodeIndex),
  }));
}

export function clearElectrodes(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, (run) => ({ ...run, electrodes: [] }));
}

export function flipDirection(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const cur = run.direction ?? defaultDirection(run);
    const next: 'forward' | 'backward' = cur === 'forward' ? 'backward' : 'forward';
    return { ...run, direction: next };
  });
}

export function placeBlockout(
  doc: DesignDoc,
  runId: string,
  startLiveIndex: number,
  endLiveIndex: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const s = Math.min(startLiveIndex, endLiveIndex);
    const e = Math.max(startLiveIndex, endLiveIndex);
    const blockouts: Blockout[] = [...(run.blockouts ?? []), { start_live_index: s, end_live_index: e }];
    return { ...run, blockouts };
  });
}

export function deleteBlockout(doc: DesignDoc, runId: string, blockoutIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    blockouts: (run.blockouts ?? []).filter((_, i) => i !== blockoutIndex),
  }));
}

export function placeAnnotation(
  doc: DesignDoc,
  runId: string,
  kind: Annotation['kind'],
  liveIndex: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    annotations: [...(run.annotations ?? []), { kind, live_index: liveIndex }],
  }));
}

export function deleteAnnotation(doc: DesignDoc, runId: string, annotationIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    annotations: (run.annotations ?? []).filter((_, i) => i !== annotationIndex),
  }));
}

export function placeBend(
  doc: DesignDoc,
  runId: string,
  liveIndex: number,
  projectDiameterMM: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const seed: Bend[] = run.bends && run.bends.length > 0
      ? run.bends
      : computeBends(run, projectDiameterMM).map((b: BendPoint) => ({ live_index: b.liveIndex }));
    if (seed.some((b) => Math.abs(b.live_index - liveIndex) < 2)) {
      return { ...run, bends: seed };
    }
    const bends = [...seed, { live_index: liveIndex }].sort((a, b) => a.live_index - b.live_index);
    return { ...run, bends };
  });
}

export function deleteBend(
  doc: DesignDoc,
  runId: string,
  bendIndex: number,
  projectDiameterMM: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const seed: Bend[] = run.bends && run.bends.length > 0
      ? run.bends
      : computeBends(run, projectDiameterMM).map((b: BendPoint) => ({ live_index: b.liveIndex }));
    return { ...run, bends: seed.filter((_, i) => i !== bendIndex) };
  });
}

export function resetBends(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const { bends: _drop, ...rest } = run;
    return rest;
  });
}

export function setRunColor(doc: DesignDoc, runId: string, color: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (color === '') {
      const { color: _drop, ...rest } = run;
      return rest;
    }
    return { ...run, color };
  });
}

export function setRunDiameter(doc: DesignDoc, runId: string, diameterMM: number | null): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (diameterMM == null || Number.isNaN(diameterMM) || diameterMM <= 0) {
      const { tube_diameter_mm: _drop, ...rest } = run;
      return rest;
    }
    return { ...run, tube_diameter_mm: diameterMM };
  });
}

export function setRunNotes(doc: DesignDoc, runId: string, notes: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (notes.trim() === '') {
      const { notes: _drop, ...rest } = run;
      return rest;
    }
    return { ...run, notes };
  });
}

export function placeLabel(doc: DesignDoc, x: number, y: number, text: string): DesignDoc {
  const label: Label = { x, y, text };
  return { ...doc, labels: [...(doc.labels ?? []), label] };
}

export function deleteLabel(doc: DesignDoc, index: number): DesignDoc {
  return { ...doc, labels: (doc.labels ?? []).filter((_, i) => i !== index) };
}

export function placeDimension(
  doc: DesignDoc,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  note?: string,
): DesignDoc {
  const dim: Dimension = note ? { x1, y1, x2, y2, note } : { x1, y1, x2, y2 };
  return { ...doc, dimensions: [...(doc.dimensions ?? []), dim] };
}

export function deleteDimension(doc: DesignDoc, index: number): DesignDoc {
  return { ...doc, dimensions: (doc.dimensions ?? []).filter((_, i) => i !== index) };
}

export function moveVertex(
  doc: DesignDoc,
  runId: string,
  pointIndex: number,
  x: number,
  y: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (pointIndex < 0 || pointIndex >= run.polyline.points.length) return run;
    if (run.polyline.points[pointIndex][0] === x && run.polyline.points[pointIndex][1] === y) return run;
    const points = run.polyline.points.slice();
    points[pointIndex] = [x, y];
    return { ...run, polyline: { ...run.polyline, points } };
  });
}

export function deleteVertex(doc: DesignDoc, runId: string, pointIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const minPts = run.polyline.closed ? 3 : 2;
    if (run.polyline.points.length <= minPts) return run;
    const points = run.polyline.points.filter((_, i) => i !== pointIndex);
    const shift = (i: number) => (i > pointIndex ? i - 1 : i);
    const electrodes = (run.electrodes ?? [])
      .filter((e) => e.point_index !== pointIndex)
      .map((e) => ({ ...e, point_index: shift(e.point_index) }));
    return {
      ...run,
      polyline: { ...run.polyline, points },
      electrodes,
    };
  });
}
