import type { DesignDoc } from '../api';
import { runArcs } from './runArcs';
import { segmentTypeAt } from './arcGeom';

// Tier 3 #76 — every action the node-edit context menu can offer at a
// vertex. Deliberately a closed union rather than free-form strings: the
// menu component, the dispatcher in EditorCanvas and the tests all key
// off it, so a typo is a type error rather than a menu item that
// silently does nothing.
export type NodeMenuActionId =
  | 'insert-vertex'
  | 'insert-doubleback'
  | 'split-run'
  | 'break-loop-open'
  | 'move-opening'
  | 'place-electrode'
  | 'delete-electrode'
  | 'add-housing'
  | 'blockout-from-here'
  | 'mark-jump'
  | 'mark-support'
  | 'mark-doubleback'
  | 'mark-drop-bend'
  | 'mark-special-bend'
  | 'convert-to-arc'
  | 'convert-to-line'
  | 'delete-vertex';

// Items are grouped so the menu can rule between them. Order within the
// returned array is the render order.
export type NodeMenuGroup = 'geometry' | 'electrode' | 'marks' | 'destructive';

export type NodeMenuItem = {
  id: NodeMenuActionId;
  label: string;
  hint?: string;
  group: NodeMenuGroup;
};

// availableActionsForVertex returns the actions that actually apply at
// one vertex, in render order.
//
// Inapplicable actions are OMITTED, not greyed out. A context menu is
// read in the half-second after a right-click; a list where half the
// rows are dead costs the operator more than it teaches them. (The spec
// says "disabled" in one line of its manual-smoke section and "returns
// only items applicable to context" in the deliverable — this follows
// the deliverable.)
//
// Every gate below mirrors a real precondition in docOps, not a guess.
// Where an op would silently no-op or throw, the item is not offered:
//
//   insertVertex     — needs a forward segment (segmentIndex < n-1)
//   insertDoubleback — same, and the segment must have non-zero length
//   splitRun         — needs 0 < pointIndex < n-1
//   breakOpen        — closed run, >= 3 vertices
//   moveOpening      — open run, exactly 2 electrodes, and a rotation to
//                      vertex 0 is a no-op so it is not offered there
//   deleteVertex     — refuses below 3 vertices closed / 2 open
//   annotations/bends— anchor by LIVE index, so a vertex on a closed
//                      loop's dead arc has no live index to anchor to
export function availableActionsForVertex(
  doc: DesignDoc,
  runId: string,
  vertexIndex: number,
): NodeMenuItem[] {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return [];
  const pts = run.polyline.points;
  const n = pts.length;
  if (vertexIndex < 0 || vertexIndex >= n) return [];

  const closed = !!run.polyline.closed;
  const electrodes = run.electrodes ?? [];
  const electrodeAtVertex = electrodes.findIndex((e) => e.point_index === vertexIndex);
  const hasElectrodeHere = electrodeAtVertex >= 0;

  // Annotations and bends anchor by live index, so a vertex has to be on
  // the live arc to carry one. For an open run that is every vertex; for
  // a closed loop with two electrodes it is only the live half.
  const live = runArcs(run).live;
  const onLiveArc = live.indexOf(vertexIndex) >= 0;

  const hasForwardSegment = vertexIndex < n - 1;
  const forwardSegmentHasLength =
    hasForwardSegment &&
    (pts[vertexIndex][0] !== pts[vertexIndex + 1][0] ||
      pts[vertexIndex][1] !== pts[vertexIndex + 1][1]);

  const items: NodeMenuItem[] = [];

  if (hasForwardSegment) {
    items.push({
      id: 'insert-vertex',
      label: 'Insert vertex after',
      hint: 'Midpoint of the next segment',
      group: 'geometry',
    });
  }
  if (forwardSegmentHasLength) {
    items.push({
      id: 'insert-doubleback',
      label: 'Insert doubleback',
      hint: 'Hold Shift for the right side',
      group: 'geometry',
    });
    // Tier 3 #78 — the segment LEAVING this vertex. Only one of the two shows,
    // because offering "convert to line" on a segment that is already straight
    // is a row that does nothing. Needs a non-zero chord: an arc through two
    // coincident points has no circle.
    if (segmentTypeAt(run, vertexIndex) === 'arc') {
      items.push({
        id: 'convert-to-line',
        label: 'Convert to line',
        hint: 'Straighten the segment after this vertex',
        group: 'geometry',
      });
    } else {
      items.push({
        id: 'convert-to-arc',
        label: 'Convert to arc',
        hint: 'Curve the segment after this vertex',
        group: 'geometry',
      });
    }
  }
  // splitRun slices the point list and clears `closed`, which drops a
  // closed loop's closing segment on the floor — the two pieces no longer
  // trace the shape the operator drew. Breaking the loop open first is the
  // correct route, so that is what a closed run is offered instead.
  if (!closed && vertexIndex > 0 && vertexIndex < n - 1) {
    items.push({ id: 'split-run', label: 'Split run here', group: 'geometry' });
  }
  if (closed && n >= 3) {
    items.push({
      id: 'break-loop-open',
      label: 'Break loop open here',
      hint: 'Places electrodes on both new ends',
      group: 'geometry',
    });
  }
  if (!closed && electrodes.length === 2 && vertexIndex > 0) {
    items.push({
      id: 'move-opening',
      label: 'Move opening here',
      hint: 'Rotates the tube so it starts at this vertex',
      group: 'geometry',
    });
  }

  if (hasElectrodeHere) {
    items.push({ id: 'add-housing', label: 'Add housing…', group: 'electrode' });
    items.push({ id: 'delete-electrode', label: 'Delete electrode', group: 'electrode' });
  } else {
    // placeElectrode does not refuse a third electrode — it relocates
    // whichever of the two is nearer. Say so, rather than letting the
    // operator discover it by watching an electrode jump across the sign.
    items.push({
      id: 'place-electrode',
      label: electrodes.length >= 2 ? 'Move nearest electrode here' : 'Place electrode here',
      group: 'electrode',
    });
  }

  if (onLiveArc) {
    items.push({
      id: 'blockout-from-here',
      label: 'Blockout from here…',
      hint: 'Then click the far end',
      group: 'marks',
    });
    items.push({ id: 'mark-jump', label: 'Mark jump', group: 'marks' });
    items.push({ id: 'mark-support', label: 'Mark tube support', group: 'marks' });
    items.push({ id: 'mark-doubleback', label: 'Mark doubleback', group: 'marks' });
    items.push({ id: 'mark-drop-bend', label: 'Mark drop bend', group: 'marks' });
    items.push({ id: 'mark-special-bend', label: 'Mark special bend', group: 'marks' });
  }

  if (n > (closed ? 3 : 2)) {
    items.push({ id: 'delete-vertex', label: 'Delete vertex', group: 'destructive' });
  }

  return items;
}
