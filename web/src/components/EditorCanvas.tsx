import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { DesignDoc, DesignRun, ValidationIssue } from '../api';
import { isGroupVisible } from '../api';
import { runArcs, indicesToD, nearestLiveArcIndex, blockoutSegments } from '../lib/runArcs';
import { colorHex } from '../lib/neonColors';
import { effectiveBends } from '../lib/bends';
import { rectToPoints } from '../lib/shapes/rect';
import { circleToPoints } from '../lib/shapes/circle';
import { threePointArcToPoints } from '../lib/shapes/arc';
import {
  drawingReducer,
  initialStateForTool,
} from '../lib/drawingState';
import {
  composeSnap,
  type GeometrySnap,
} from '../lib/snap';

type Transform = { tx: number; ty: number; k: number };

export type EditorTool =
  | 'select'
  | 'electrode'
  | 'blockout'
  | 'jump'
  | 'support'
  | 'doubleback'
  | 'insert-doubleback'
  | 'bend'
  | 'label'
  | 'dimension'
  | 'node'
  | 'pen'
  | 'rect'
  | 'circle'
  | 'arc'
  // Tier 3 #61 (NW #130) — break a closed loop open at the clicked
  // vertex (auto-places electrodes), or move an existing opening on
  // an open run with two electrodes to a different vertex. The tool
  // dispatches based on the clicked run's `closed` flag; the same
  // hover/click affordance covers both modes.
  | 'break-open'
  // Tier 3 #60 (NW #125) — Connect Tubes. Two-click tool: click an
  // electrode pin on one run (source pulses green), then click an
  // electrode on a DIFFERENT run to commit a jumper run between
  // them. Esc / right-click cancels the staged source.
  | 'connect';

export type AnnotationKind = 'jump' | 'support' | 'doubleback';

type StagedBlockout = { runId: string; liveIndex: number };

const MIN_SCALE = 0.05;
const MAX_SCALE = 200;

export default function EditorCanvas({
  doc,
  tool,
  selectedRunIds,
  projectDiameterMM,
  snapEnabled,
  snapMM,
  onSelectRun,
  onPlaceElectrode,
  onDeleteElectrode,
  onElectrodeContextMenu,
  onPlaceBlockout,
  onPlaceAnnotation,
  onDeleteAnnotation,
  onPlaceBend,
  onPlaceLabel,
  onPlaceDimension,
  onDeleteLabel,
  onDeleteDimension,
  onMoveVertex,
  onMoveVertices,
  onMergeVertices,
  onDeleteVertex,
  onInsertVertex,
  onSplitRun,
  joinArm,
  onPickJoinEndpoint,
  onInsertDoubleback,
  onBreakOpen,
  onMoveOpening,
  onConnectTubes,
  onCommitShape,
  validationIssues,
  issueSeverityFilter,
  hoveredIssueIndex,
  onIssueHover,
  centerOnIssue,
}: {
  doc: DesignDoc;
  tool: EditorTool;
  // Tier 3 #33a — multi-select. `selectedRunIds` is the canonical
  // source of truth for which runs render with a selection ring. Empty
  // array means "nothing selected"; a length-1 array is the equivalent
  // of the legacy single-select state. The "primary" run for tools that
  // still operate on one run at a time (node-edit, alt-click bend) is
  // the LAST entry — most recently clicked or toggled-in.
  selectedRunIds: string[];
  projectDiameterMM: number;
  snapEnabled: boolean;
  snapMM: number;
  // Tier 3 #28 — Validator-emitted issues to render as colored markers
  // on the canvas at their `(x_mm, y_mm)` coordinates. Optional: when
  // omitted (or empty), the marker layer renders nothing. The canvas
  // does not own the validation lifecycle — EditorPage threads in the
  // latest report whenever live validation refreshes.
  //
  // Tier 3 #47: indices are GLOBAL (into this same array). The canvas
  // filters by severity internally so the index space stays consistent
  // with the sidebar (which thinks in `report.issues` indices too).
  validationIssues?: ValidationIssue[];
  // Tier 3 #47 — when provided, errors/warnings can be hidden
  // independently. Defaults: both visible. Filtering happens during
  // marker render — the index in the markup still maps back to the
  // global `validationIssues` array, so hover events stay coherent.
  issueSeverityFilter?: { errors: boolean; warnings: boolean };
  // Tier 3 #47 — sidebar↔canvas hover linking. When set, the marker
  // at the matching GLOBAL index in `validationIssues` is rendered
  // with the pulse-highlight class, drawing the operator's eye to it.
  hoveredIssueIndex?: number | null;
  // Emitted when the cursor enters / leaves a marker. The argument is
  // the global index INTO `validationIssues`. EditorPage mirrors it
  // into the sidebar issue row so the hover feels bidirectional.
  onIssueHover?: (idx: number | null) => void;
  // Tier 3 #47 — keyboard nav target. When the epoch tick changes,
  // the canvas animates its pan transform to center the world-space
  // (x, y) at the viewport midpoint. Zoom is preserved (operators
  // zoom-in to inspect a region; rescaling-to-fit on every j/k would
  // undo that). A 200 ms cubic ease-out keeps the motion subtle.
  centerOnIssue?: { x: number; y: number; epoch: number } | null;
  // Tier 3 #33a — `opts.additive` is true for Shift / Cmd-Ctrl-click;
  // the parent toggles the run in/out of the selection. Plain click
  // sends opts undefined (parent replaces the selection with [id]).
  // Background click sends id=null (parent clears the selection).
  onSelectRun: (id: string | null, opts?: { additive?: boolean }) => void;
  onPlaceElectrode: (runId: string, pointIndex: number) => void;
  onDeleteElectrode: (runId: string, electrodeIndex: number) => void;
  // Right-click on an electrode pin opens the housing picker modal
  // (Tier 3 #62). The canvas just routes the event up; EditorPage
  // owns the modal mount + setElectrodeHousing dispatch. Hovering an
  // electrode also reveals a gear-icon overlay so the right-click
  // affordance is discoverable.
  onElectrodeContextMenu?: (runId: string, electrodeIndex: number) => void;
  onPlaceBlockout: (runId: string, startLiveIndex: number, endLiveIndex: number) => void;
  onPlaceAnnotation: (runId: string, kind: AnnotationKind, liveIndex: number) => void;
  onDeleteAnnotation: (runId: string, annotationIndex: number) => void;
  onPlaceBend: (runId: string, liveIndex: number) => void;
  onPlaceLabel: (x: number, y: number) => void;
  onPlaceDimension: (x1: number, y1: number, x2: number, y2: number) => void;
  onDeleteLabel: (index: number) => void;
  onDeleteDimension: (index: number) => void;
  onMoveVertex: (runId: string, pointIndex: number, x: number, y: number) => void;
  // Tier 3 #48 — multi-vertex drag. Fired in place of `onMoveVertex`
  // when two or more vertices on the same run are selected and the
  // operator drags any of them: the canvas computes the per-vertex
  // target XY (anchor + delta) and submits the batch as one undo
  // entry. Empty / single-vertex selections still go through the
  // single-vertex `onMoveVertex` path so the existing tests don't
  // need re-wiring.
  onMoveVertices: (runId: string, writes: { pointIndex: number; x: number; y: number }[]) => void;
  // Tier 3 #48 — vertex-merge on drop. Surfaced when a node-edit drag
  // releases inside the snap-to-vertex radius of another vertex on the
  // same run. The canvas picks `keepIndex` (the un-dragged target) and
  // `dropIndex` (the dragged vertex) so the kept vertex's XY survives
  // the merge — this matches the visual feedback the operator was
  // looking at (the snap ring on the target).
  onMergeVertices: (runId: string, keepIndex: number, dropIndex: number) => void;
  onDeleteVertex: (runId: string, pointIndex: number) => void;
  // Insert a new vertex on the run's polyline at the picked segment + t.
  // Surfaced as alt-click on a polyline path (away from existing vertex
  // handles) while the node tool is active.
  onInsertVertex: (runId: string, segmentIndex: number, t: number) => void;
  // Split a run into two new runs at the chosen vertex. Surfaced as
  // alt-click on a NodeHandle while the node tool is active.
  onSplitRun: (runId: string, pointIndex: number) => void;
  // The currently-armed first endpoint of a join, if any. EditorPage's
  // sidebar arms it (e.g. "Join from head" on the selected open run).
  // While set, the canvas highlights every other open-run endpoint so
  // the user can click the second one to commit.
  joinArm: { runId: string; endpoint: 'head' | 'tail' } | null;
  // Called when the user clicks an endpoint while joinArm is set. The
  // parent commits the join op + clears the arm.
  onPickJoinEndpoint: (runId: string, endpoint: 'head' | 'tail') => void;
  // Splice a hairpin into the run's polyline at the picked segment + t.
  // `side` mirrors the U onto the opposite side of the segment when set
  // — surfaced as a shift-click in the canvas.
  onInsertDoubleback: (runId: string, segmentIndex: number, t: number, side: 'left' | 'right') => void;
  // Tier 3 #61 (NW #130) — break-open / move-opening. The canvas's
  // `'break-open'` tool routes a click on a closed run to onBreakOpen
  // (auto-creating an opening at the nearest vertex) and a click on
  // an open run to onMoveOpening (rotating the polyline so the
  // electrode opening lands at the chosen vertex). Both fire only
  // when the click lands within the snap-to-vertex radius.
  onBreakOpen: (runId: string, vertexIndex: number) => void;
  onMoveOpening: (runId: string, newStartVertexIndex: number) => void;
  // Tier 3 #60 (NW #125) — Connect Tubes click-tool committer. Fires
  // on the second click of the connect-tubes flow once the user has
  // staged a source electrode and clicked a target electrode on a
  // different run. EditorPage owns the docOps.connectTubes dispatch
  // and the OperationError → setError plumbing.
  onConnectTubes: (
    fromRunId: string,
    fromElectrodeIdx: number,
    toRunId: string,
    toElectrodeIdx: number,
  ) => void;
  // Commit a freshly drawn shape as a new run. EditorPage owns the
  // appendRuns / id-prefix logic; the canvas just hands up the geometry
  // and the kind so the parent can pick the right id prefix and decide on
  // direction/electrodes (for V1: none).
  onCommitShape: (kind: 'pen' | 'rect' | 'circle' | 'arc', points: [number, number][], closed: boolean) => void;
}) {
  // Tier 3 #33a — most-recently-selected run, used by tools that still
  // operate on a single run at a time (node-edit handles, bend marker
  // overlay, alt-click vertex insert). Multi-select rendering loops
  // over `selectedRunIds` directly.
  const primarySelectedRunId =
    selectedRunIds.length > 0 ? selectedRunIds[selectedRunIds.length - 1] : null;
  const primarySelectedRunIdSet = useMemo(
    () => new Set(selectedRunIds),
    [selectedRunIds],
  );

  // Tier 3 #33c — per-run flags from the Layers panel. `hidden` skips
  // the run from the canvas render entirely (the polyline isn't even
  // emitted, so there's no SVG node to hit-test). `locked` keeps the
  // run rendered but sets `pointer-events: none` on its hit-target
  // path AND excludes it from any nearest-run hit-test the canvas
  // runs in pointer handlers. Both flags are display-only — neither
  // affects validation, save, PDF, or DXF output.
  //
  // Lookup is by group_id → group; ungrouped runs are always visible
  // and never locked (they have no group entry to flag). The map is
  // memoized on `doc.groups` so a polyline edit doesn't churn it.
  const groupFlagMap = useMemo(() => {
    const map = new Map<string, { visible: boolean; locked: boolean }>();
    for (const g of doc.groups ?? []) {
      map.set(g.id, { visible: isGroupVisible(g), locked: !!g.locked });
    }
    return map;
  }, [doc.groups]);
  const isRunVisible = (run: DesignRun): boolean => {
    if (!run.group_id) return true;
    const flags = groupFlagMap.get(run.group_id);
    return flags ? flags.visible : true;
  };
  const isRunLocked = (run: DesignRun): boolean => {
    if (!run.group_id) return false;
    const flags = groupFlagMap.get(run.group_id);
    return flags ? flags.locked : false;
  };

  // Tier 3 #33b — group outlines. For each group with 2+ members,
  // compute the axis-aligned bbox enclosing every member's polyline
  // points and emit a pale dashed rectangle so the operator can see
  // group membership at a glance. Single-member groups are skipped:
  // a "group of 1" is meaningless and the existing selection ring
  // already covers it. Re-runs only when `doc.runs` or `doc.groups`
  // changes (run polyline edits invalidate the bbox; group rename
  // doesn't but is cheap to recompute).
  //
  // Tier 3 #33c — hidden groups are skipped from the bbox draw too
  // (no point in marking the bounds of an invisible cluster).
  const groupBBoxes = useMemo(() => {
    const out: { id: string; minX: number; minY: number; maxX: number; maxY: number }[] = [];
    for (const g of doc.groups ?? []) {
      if (!isGroupVisible(g)) continue;
      const members = doc.runs.filter((r) => r.group_id === g.id);
      if (members.length < 2) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let any = false;
      for (const m of members) {
        for (const [x, y] of m.polyline.points) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
          any = true;
        }
      }
      if (!any) continue;
      out.push({ id: g.id, minX, minY, maxX, maxY });
    }
    return out;
  }, [doc.runs, doc.groups]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ tx: 0, ty: 0, k: 1 });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });
  const [staged, setStaged] = useState<StagedBlockout | null>(null);
  const [stagedDim, setStagedDim] = useState<{ x: number; y: number } | null>(null);
  // Tier 3 #42 — drawing-tool anchor state lives in one reducer keyed
  // on the active tool. `switchTool` reseeds with the destination
  // tool's initial state so stale anchors can't leak. See
  // `lib/drawingState.ts` for the transition table + unit tests.
  const [drawing, dispatch] = useReducer(drawingReducer, tool, initialStateForTool);
  // Live cursor previews (rubber-band / drag-current). Out of the
  // reducer because they churn every pointermove; the render path
  // gates them on the reducer's anchor state so stale hovers can't
  // leak across tools either.
  const [penHover, setPenHover] = useState<[number, number] | null>(null);
  const [shapeCurrent, setShapeCurrent] = useState<[number, number] | null>(null);
  const [arcHover, setArcHover] = useState<[number, number] | null>(null);
  // Tier 3 #34 — drawing-tool snap composition state. `isShiftHeld`
  // engages angle-snap (cursor locks to nearest 15° increment from the
  // working anchor). `geometryHover` carries the currently-snapped
  // existing-vertex / segment-midpoint, if any, so the canvas can
  // render a hover ring while the cursor is in range. Both are local
  // to this component (no reducer dispatch) — they churn every
  // pointermove/keydown and the render path already gates on the
  // active tool, so a stale hover never paints under another tool.
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  const [geometryHover, setGeometryHover] = useState<GeometrySnap | null>(null);
  // Insert-doubleback tool: hover-tracked nearest segment + parametric
  // position so the canvas can render a ghost preview of the hairpin
  // before the user commits.
  const [dbHover, setDbHover] = useState<{
    runId: string;
    segmentIndex: number;
    t: number;
    side: 'left' | 'right';
  } | null>(null);
  // Node-edit tool (Tier 3 #25): the polyline vertex the cursor is
  // currently snapping toward while the user holds Alt to preview an
  // insert. When non-null we render a hover ring on that vertex so
  // "alt-click here will reuse the existing vertex" is visually
  // distinct from "alt-click here will insert a new one". Cleared on
  // tool change (see the tool-change effect below) and on Alt
  // release / pointer leave.
  const [hoveredVertex, setHoveredVertex] = useState<{
    runId: string;
    pointIndex: number;
  } | null>(null);
  // Tier 3 #48 — multi-vertex selection inside the node-edit tool.
  // Scoped to ONE run (the primary-selected run that node-edit operates
  // on) since vertex coordinates are run-local; cross-run vertex drag
  // would need a different op signature. Cmd/Ctrl-click on a vertex
  // toggles it in/out of the set; Cmd/Ctrl + drag on the empty canvas
  // draws a rubber-band rect that selects every vertex on the primary
  // run inside it on release. A length-0 / length-1 set behaves like
  // the legacy single-vertex flow (drag one vertex, the others are
  // unaffected).
  const [selectedVertices, setSelectedVertices] = useState<{
    runId: string;
    indices: Set<number>;
  } | null>(null);
  // Rubber-band live state. World-space anchor + current corner; the
  // render layer paints the dashed rectangle. On release the canvas
  // walks the primary-selected run's polyline and marks every vertex
  // inside the rect as selected. Cleared when the rubber-band ends or
  // the tool changes.
  const [rubberBand, setRubberBand] = useState<{
    runId: string;
    anchor: [number, number];
    current: [number, number];
    additive: boolean;
  } | null>(null);
  // Anchor snapshot for an active multi-vertex drag. When the operator
  // grabs a NodeHandle that's part of a multi-vertex selection, we
  // remember every selected vertex's pre-drag XY. The handle's
  // pointermove computes a world-space delta against the dragged
  // vertex's anchor and applies the same delta to all anchors so every
  // selected vertex translates by the same amount. Cleared on
  // pointerup. Out-of-band so the handle-internal drag state can be
  // simple (just "is this dragging?").
  const multiDragRef = useRef<{
    runId: string;
    draggedIndex: number;
    anchorXY: [number, number];
    snapshots: Map<number, [number, number]>;
  } | null>(null);
  // Tier 3 #62 — hovered-electrode tracking. When non-null and the
  // operator has a contextmenu handler wired in, we render a small ⚙
  // icon next to the marker so the right-click affordance is
  // discoverable (otherwise the only cue is "right-click on the pin",
  // which is unobvious). Cleared when the mouse leaves the marker.
  const [hoveredElectrode, setHoveredElectrode] = useState<{
    runId: string;
    electrodeIndex: number;
  } | null>(null);
  // Tier 3 #60 — Connect Tubes staged source. After the first click
  // on an electrode in 'connect' mode, we remember which electrode
  // was picked so the second click can commit a jumper. Cursor world-
  // space position is tracked separately in `connectHover` so the
  // dashed live preview line follows the pointer between clicks.
  const [connectStaged, setConnectStaged] = useState<{
    runId: string;
    electrodeIndex: number;
  } | null>(null);
  const [connectHover, setConnectHover] = useState<[number, number] | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number; moved: boolean } | null>(null);

  // Tier 3 #48 — vertex drag dispatch. The NodeHandle's `onMove`
  // callback routes through here so a single-vertex drag still goes
  // through `onMoveVertex` (preserving every existing test that pins
  // the single-vertex API), while a drag of any vertex inside a
  // multi-select set translates the whole set by the same delta via
  // `onMoveVertices`. The first onMove of a multi-drag snapshots every
  // selected vertex's pre-drag XY into `multiDragRef`; subsequent moves
  // compute a world-space delta from the dragged vertex's anchor and
  // apply it to all anchors.
  function dispatchVertexMove(runId: string, pointIndex: number, nx: number, ny: number) {
    const sel = selectedVertices;
    const isMulti =
      sel !== null &&
      sel.runId === runId &&
      sel.indices.size >= 2 &&
      sel.indices.has(pointIndex);
    if (!isMulti) {
      onMoveVertex(runId, pointIndex, nx, ny);
      return;
    }
    if (!multiDragRef.current || multiDragRef.current.draggedIndex !== pointIndex) {
      // First move of this drag — snapshot every selected vertex's XY.
      const run = doc.runs.find((r) => r.id === runId);
      if (!run) {
        onMoveVertex(runId, pointIndex, nx, ny);
        return;
      }
      const snapshots = new Map<number, [number, number]>();
      for (const idx of sel.indices) {
        const p = run.polyline.points[idx];
        if (p) snapshots.set(idx, [p[0], p[1]]);
      }
      const anchor = snapshots.get(pointIndex) ?? [nx, ny];
      multiDragRef.current = {
        runId,
        draggedIndex: pointIndex,
        anchorXY: anchor,
        snapshots,
      };
    }
    const drag = multiDragRef.current;
    const dx = nx - drag.anchorXY[0];
    const dy = ny - drag.anchorXY[1];
    const writes: { pointIndex: number; x: number; y: number }[] = [];
    for (const [idx, anchor] of drag.snapshots) {
      writes.push({ pointIndex: idx, x: anchor[0] + dx, y: anchor[1] + dy });
    }
    onMoveVertices(runId, writes);
  }

  // Tier 3 #48 — vertex-merge on drop. When a node-edit drag ends, we
  // probe the run's other vertices for one within snap-to-vertex range
  // of the drop point. If found, fire `onMergeVertices` to fold the
  // dropped vertex into the target. Single-vertex drags only — a multi-
  // drag is a translate, not a merge (and merging into one of your own
  // dragged vertices would be non-sensical).
  function handleVertexDragEnd(runId: string, pointIndex: number, x: number, y: number) {
    const wasMulti = multiDragRef.current !== null;
    multiDragRef.current = null;
    if (wasMulti) return;
    const run = doc.runs.find((r) => r.id === runId);
    if (!run) return;
    const radius = nodeSnapRadiusMM(transform.k, snapEnabled, snapMM);
    const r2 = radius * radius;
    let bestIdx: number | null = null;
    let bestD = r2;
    for (let i = 0; i < run.polyline.points.length; i++) {
      if (i === pointIndex) continue;
      const p = run.polyline.points[i];
      const ddx = p[0] - x;
      const ddy = p[1] - y;
      const d = ddx * ddx + ddy * ddy;
      if (d <= bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx !== null) {
      onMergeVertices(runId, bestIdx, pointIndex);
      // Drop multi-vertex selection if the dropped index was part of
      // it — its index is gone after the merge.
      if (selectedVertices && selectedVertices.runId === runId && selectedVertices.indices.has(pointIndex)) {
        setSelectedVertices(null);
      }
    }
  }

  // Tier 3 #48 — toggle a vertex in/out of the multi-vertex selection.
  // Cmd/Ctrl-click on a NodeHandle routes here. The selection is
  // single-run scoped (see `selectedVertices` declaration); a click on
  // a vertex of a different run replaces the slice rather than mixing
  // them. Empty result (toggled the only entry off) clears the slice.
  function toggleSelectedVertex(runId: string, pointIndex: number) {
    setSelectedVertices((prev) => {
      if (!prev || prev.runId !== runId) {
        return { runId, indices: new Set([pointIndex]) };
      }
      const next = new Set(prev.indices);
      if (next.has(pointIndex)) next.delete(pointIndex);
      else next.add(pointIndex);
      if (next.size === 0) return null;
      return { runId, indices: next };
    });
  }

  // Tool-change cleanup, render-phase per the "previous prop" React
  // pattern (avoids the cascading-render hit of a useEffect, and keeps
  // react-hooks/set-state-in-effect happy). The reducer handles its
  // own reset via `switchTool`; the inline calls below clear live
  // hover state and the four non-drawing-tool staged values (blockout,
  // dimension, insert-doubleback hover, node alt-hover).
  const [prevTool, setPrevTool] = useState(tool);
  if (prevTool !== tool) {
    setPrevTool(tool);
    dispatch({ type: 'switchTool', tool });
    if (penHover !== null) setPenHover(null);
    if (shapeCurrent !== null) setShapeCurrent(null);
    if (arcHover !== null) setArcHover(null);
    if (tool !== 'blockout' && staged !== null) setStaged(null);
    if (tool !== 'dimension' && stagedDim !== null) setStagedDim(null);
    if (tool !== 'insert-doubleback' && dbHover !== null) setDbHover(null);
    // Tier 3 #25 (node) and #61 (break-open) share the hoveredVertex
    // hover-ring state — only clear it when neither tool is active so
    // toggling between them doesn't blink the highlight.
    if (tool !== 'node' && tool !== 'break-open' && hoveredVertex !== null) setHoveredVertex(null);
    // Tier 3 #48 — leaving the node tool drops the multi-vertex slice
    // and any in-progress rubber-band so they don't leak across tools.
    if (tool !== 'node') {
      if (selectedVertices !== null) setSelectedVertices(null);
      if (rubberBand !== null) setRubberBand(null);
    }
    if (geometryHover !== null) setGeometryHover(null);
    // Tier 3 #60 — leaving the connect tool drops any staged source
    // and the live-preview hover so they don't ambush the operator
    // when they come back.
    if (tool !== 'connect') {
      if (connectStaged !== null) setConnectStaged(null);
      if (connectHover !== null) setConnectHover(null);
    }
  }

  // Tier 3 #48 — when the primary-selected run changes, the vertex
  // multi-select slice would still point at the prior run's polyline
  // indices. Same render-phase "previous prop" pattern used above.
  // The polyline-length watch covers the second-failure case: a vertex
  // op (insert / delete / merge) shrinks or grows the polyline; any
  // selected index past the new length must drop or it renders a
  // ghost NodeHandle.
  const primaryPolyLen = useMemo(() => {
    if (!primarySelectedRunId) return 0;
    const run = doc.runs.find((r) => r.id === primarySelectedRunId);
    return run ? run.polyline.points.length : 0;
  }, [doc.runs, primarySelectedRunId]);
  const [prevPrimaryRunId, setPrevPrimaryRunId] = useState(primarySelectedRunId);
  const [prevPolyLen, setPrevPolyLen] = useState(primaryPolyLen);
  if (prevPrimaryRunId !== primarySelectedRunId) {
    setPrevPrimaryRunId(primarySelectedRunId);
    setPrevPolyLen(primaryPolyLen);
    if (selectedVertices !== null && selectedVertices.runId !== primarySelectedRunId) {
      setSelectedVertices(null);
    }
    if (rubberBand !== null && rubberBand.runId !== primarySelectedRunId) {
      setRubberBand(null);
    }
  } else if (prevPolyLen !== primaryPolyLen) {
    setPrevPolyLen(primaryPolyLen);
    if (selectedVertices !== null && selectedVertices.runId === primarySelectedRunId) {
      // Prune indices that no longer point at a valid vertex; if the
      // pruned set is empty, drop the slice entirely.
      const pruned = new Set<number>();
      for (const i of selectedVertices.indices) {
        if (i < primaryPolyLen) pruned.add(i);
      }
      if (pruned.size !== selectedVertices.indices.size) {
        if (pruned.size === 0) setSelectedVertices(null);
        else setSelectedVertices({ runId: primarySelectedRunId, indices: pruned });
      }
    }
  }

  // Pen / arc tools: Enter commits the in-progress pen polyline (if it has
  // ≥2 vertices); Esc abandons whichever tool's in-progress shape. Skipped
  // when the user is typing into an input — otherwise drawing tool keys
  // would hijack form inputs in the sidebar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape') {
        // Tier 3 #60 — Esc cancels a staged Connect-Tubes source.
        // Listed first so it wins when the operator pressed Esc while
        // any in-progress drawing tool was idle.
        if (tool === 'connect' && connectStaged !== null) {
          e.preventDefault();
          setConnectStaged(null);
          setConnectHover(null);
          return;
        }
        // Tier 3 #48 — Esc clears the multi-vertex selection inside
        // the node tool. Listed before the parent's run-deselect Esc
        // handler (which fires only when nothing inner-canvas claimed
        // the key first) so the operator can clear the vertex slice
        // without losing the run selection.
        if (tool === 'node' && selectedVertices !== null) {
          e.preventDefault();
          setSelectedVertices(null);
          return;
        }
        if (drawing.tool === 'pen' && drawing.vertices.length > 0) {
          e.preventDefault();
          dispatch({ type: 'penCancel' });
          setPenHover(null);
          return;
        }
        if (drawing.tool === 'arc' && (drawing.firstClick !== null || drawing.secondClick !== null)) {
          e.preventDefault();
          dispatch({ type: 'arcCommit' });
          setArcHover(null);
          return;
        }
        if (drawing.tool === 'rect' && drawing.firstCorner !== null) {
          e.preventDefault();
          dispatch({ type: 'rectCommit' });
          setShapeCurrent(null);
          return;
        }
        if (drawing.tool === 'circle' && drawing.center !== null) {
          e.preventDefault();
          dispatch({ type: 'circleCommit' });
          setShapeCurrent(null);
          return;
        }
      }
      if (e.key === 'Enter') {
        if (drawing.tool === 'pen' && drawing.vertices.length >= 2) {
          e.preventDefault();
          onCommitShape('pen', drawing.vertices.slice(), false);
          dispatch({ type: 'penCommit' });
          setPenHover(null);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, onCommitShape, tool, connectStaged, selectedVertices]);

  // Tier 3 #34 — track Shift independently of any focused element so
  // the angle-snap engages whenever the user holds Shift over the
  // canvas, even if the focus is in the toolbar after toggling a
  // sidebar control. Mirroring on `keyup` and `blur` covers the
  // alt-tab-while-held case (avoids a sticky engaged-shift state).
  useEffect(() => {
    function onDown(e: KeyboardEvent) {
      if (e.key === 'Shift' && !isShiftHeld) setIsShiftHeld(true);
    }
    function onUp(e: KeyboardEvent) {
      if (e.key === 'Shift' && isShiftHeld) setIsShiftHeld(false);
    }
    function onBlur() {
      if (isShiftHeld) setIsShiftHeld(false);
    }
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [isShiftHeld]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = e.contentRect;
        setSize({ w: r.width, h: r.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Fit on first measurement of the design doc. Implemented with the
  // "store previous prop in state" pattern so the fit happens during
  // render — that bypasses the cascading-render hit a useEffect-based
  // fit would take, and avoids the react-hooks/refs warning we'd get
  // from gating on a ref. Once we've fit a particular doc we leave the
  // user's pan/zoom alone until a new doc arrives.
  const [fittedDoc, setFittedDoc] = useState<DesignDoc | null>(null);
  if (size.w > 0 && size.h > 0 && fittedDoc !== doc) {
    const [x, y, w, h] = doc.view_box_mm;
    if (w > 0 && h > 0) {
      setFittedDoc(doc);
      const padding = 0.9;
      const scale = Math.min(size.w / w, size.h / h) * padding;
      const next: Transform = {
        k: scale,
        tx: size.w / 2 - (x + w / 2) * scale,
        ty: size.h / 2 - (y + h / 2) * scale,
      };
      if (transform.k !== next.k || transform.tx !== next.tx || transform.ty !== next.ty) {
        setTransform(next);
      }
    }
  }

  // Tier 3 #47 — pan-zoom to a target world-space point on keyboard
  // nav (j/k/[/]). The parent passes a stable `(x, y, epoch)` triple
  // and bumps `epoch` for each command. We animate `transform.tx/ty`
  // over 200 ms (cubic ease-out) to land (x, y) at the viewport
  // center, while preserving zoom — operators frequently zoom in to
  // inspect a region, and rescaling-to-fit on every j/k would undo
  // that. The ref-driven loop avoids re-triggering on intermediate
  // setTransform calls (otherwise the user's wheel-zoom mid-animation
  // would restart the tween).
  const animFrameRef = useRef<number | null>(null);
  const lastEpochRef = useRef<number | null>(null);
  useEffect(() => {
    if (!centerOnIssue) return;
    if (lastEpochRef.current === centerOnIssue.epoch) return;
    lastEpochRef.current = centerOnIssue.epoch;
    if (size.w === 0 || size.h === 0) return;
    if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
    // Snapshot the starting transform so each rAF tick lerps from the
    // same baseline — reading the latest transform off state would
    // chase a moving target as the tween itself updates state.
    const startTx = transform.tx;
    const startTy = transform.ty;
    const k = transform.k;
    const targetTx = size.w / 2 - centerOnIssue.x * k;
    const targetTy = size.h / 2 - centerOnIssue.y * k;
    const dur = 200;
    const t0 = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // cubic ease-out
    function step(now: number) {
      const u = Math.min(1, (now - t0) / dur);
      const e = ease(u);
      setTransform((prev) => ({
        k: prev.k,
        tx: startTx + (targetTx - startTx) * e,
        ty: startTy + (targetTy - startTy) * e,
      }));
      if (u < 1) {
        animFrameRef.current = requestAnimationFrame(step);
      } else {
        animFrameRef.current = null;
      }
    }
    animFrameRef.current = requestAnimationFrame(step);
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
    // We deliberately depend only on `epoch` (and size, in case the
    // viewport just measured) — re-running the tween every time the
    // transform updates mid-tween would loop infinitely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerOnIssue?.epoch, size.w, size.h]);

  function clientToWorld(clientX: number, clientY: number): [number, number] | null {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    return [(px - transform.tx) / transform.k, (py - transform.ty) / transform.k];
  }

  // Snapped variant — applied at placement / drag sites that should respect
  // the user's current snap setting (label drop, dimension endpoints,
  // vertex drag). Pan and run-path picks deliberately use the un-snapped
  // clientToWorld so the cursor still tracks smoothly across the canvas.
  function clientToWorldSnapped(clientX: number, clientY: number): [number, number] | null {
    const w = clientToWorld(clientX, clientY);
    if (!w) return null;
    return snapPoint(w);
  }

  function snapPoint(w: [number, number]): [number, number] {
    if (!snapEnabled || !(snapMM > 0)) return w;
    return [Math.round(w[0] / snapMM) * snapMM, Math.round(w[1] / snapMM) * snapMM];
  }

  // Tier 3 #34 — drawing-tool snap composition (geometry > angle > grid).
  //
  // Every drawing tool that places a working point during an in-progress
  // shape routes its cursor → world conversion through here. The three
  // snap modes compose in priority order (see `lib/snap.ts`):
  //
  //   1. Geometry snap (vertex/midpoint of any existing run within the
  //      snap radius) — wins outright; the working point IS that geom.
  //   2. Angle snap (Shift held + an anchor available) — locks the
  //      direction from the anchor to the cursor onto the nearest 15°
  //      increment; cursor distance preserved.
  //   3. Grid snap (existing snapMM quantize) — the fallback used by
  //      `clientToWorldSnapped` for non-drawing sites.
  //
  // The function also updates `geometryHover` as a side effect so the
  // render layer can paint a teal ring on the snapped vertex/midpoint.
  // `anchor` is the per-tool fixed point (last pen vertex, rect first
  // corner, circle center, arc first click). `null` disables angle
  // snap — used by the pen-tool first vertex (no anchor yet) and any
  // tool branch where the angle dimension is meaningless.
  function drawSnap(
    clientX: number,
    clientY: number,
    anchor: [number, number] | null,
  ): [number, number] | null {
    const w = clientToWorld(clientX, clientY);
    if (!w) return null;
    const result = composeSnap({
      cursor: w,
      anchor,
      shiftHeld: isShiftHeld,
      runs: doc.runs,
      scale: transform.k,
      snapEnabled,
      snapMM,
    });
    // Update the hover-ring state only when it actually changes —
    // otherwise React rerenders every pointermove for nothing. Cheap
    // structural compare since the snap kind + point uniquely
    // determine the candidate.
    if (result.geometry === null) {
      if (geometryHover !== null) setGeometryHover(null);
    } else {
      const next = result.geometry;
      if (
        !geometryHover ||
        geometryHover.kind !== next.kind ||
        geometryHover.point[0] !== next.point[0] ||
        geometryHover.point[1] !== next.point[1]
      ) {
        setGeometryHover(next);
      }
    }
    return result.point;
  }

  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.001);
    setTransform((t) => {
      const newK = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.k * factor));
      const ratio = newK / t.k;
      return {
        k: newK,
        tx: cx - (cx - t.tx) * ratio,
        ty: cy - (cy - t.ty) * ratio,
      };
    });
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    // Only start pan-drag (and capture the pointer) when the press is on
    // empty canvas. If it's on a path / marker / handle, leave the pointer
    // alone so the child element's onClick / drag handlers receive the
    // events normally — capturing on the SVG retargets pointer-up + click
    // to the SVG, which is why clicks on paths weren't firing.
    const tag = (e.target as SVGElement).tagName;
    if (tag !== 'svg' && tag !== 'rect') return;
    // Rect / circle: pointer-down captures the anchor and starts the
    // drag preview. We capture the pointer so a fast drag that exits
    // the SVG before pointer-up still resolves cleanly. The reducer
    // owns the anchor; the live drag-current point is local state
    // since it churns every pointermove.
    if (tool === 'rect' || tool === 'circle') {
      // First corner / center — no anchor yet, so geometry-snap can
      // still land on an existing vertex (useful for "draw a rect from
      // this corner of the existing geometry") but angle snap has no
      // meaning for a single point.
      const world = drawSnap(e.clientX, e.clientY, null);
      if (!world) return;
      if (tool === 'rect') {
        dispatch({ type: 'rectFirstCorner', point: world });
      } else {
        dispatch({ type: 'circleCenter', point: world });
      }
      setShapeCurrent(world);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    // Tier 3 #48 — Cmd/Ctrl + drag in node mode draws a rubber-band
    // selection rect on the primary-selected run. Plain (no-modifier)
    // drag still pans, so the operator can navigate normally; the
    // modifier is the explicit "I want to multi-select vertices" cue.
    // Falls back to pan when no run is selected (rubber-band has
    // nothing to operate on).
    if (
      tool === 'node' &&
      primarySelectedRunId &&
      (e.metaKey || e.ctrlKey)
    ) {
      const w = clientToWorld(e.clientX, e.clientY);
      if (w) {
        setRubberBand({
          runId: primarySelectedRunId,
          anchor: w,
          current: w,
          additive: e.shiftKey,
        });
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        return;
      }
    }
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      tx: transform.tx,
      ty: transform.ty,
      moved: false,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    // Live preview updates for the in-progress drawing tools. These all
    // want the cursor's world-space position regardless of whether a drag
    // is in flight.
    if (drawing.tool === 'pen' && drawing.vertices.length > 0) {
      // Pen anchor for angle/geometry snap: the most recently committed
      // vertex. Shift while moving locks the in-progress segment to the
      // nearest 15° increment from that anchor.
      const lastVertex = drawing.vertices[drawing.vertices.length - 1];
      const w = drawSnap(e.clientX, e.clientY, lastVertex);
      if (w) setPenHover(w);
    }
    if (drawing.tool === 'arc' && drawing.firstClick !== null) {
      // Hover preview between clicks 1–2 (one anchor) and 2–3 (both
      // anchors): the trio (firstClick, secondClick, hover) renders
      // the candidate arc through the cursor. After arcCommit clears
      // both anchors on click 3, this condition lapses.
      //
      // Angle snap anchor: the most recently placed click (so the
      // arc-lead segment locks to a clean 15° increment when shift is
      // held). The arc itself is reconstructed from the trio in the
      // render path, so locking the chord direction is enough to give
      // the user predictable arc shapes.
      const arcAnchor = drawing.secondClick ?? drawing.firstClick;
      const w = drawSnap(e.clientX, e.clientY, arcAnchor);
      if (w) setArcHover(w);
    }
    // Tier 3 #25 — node-edit alt-hover. When the user holds Alt over the
    // selected run while the node tool is active, find the nearest
    // existing vertex and (if within the snap radius) flag it as the
    // current snap target. The visible ring renders below; the alt-click
    // handler in onRunClick consults the same state to skip a redundant
    // insert.
    //
    // Tier 3 #48 — when joinArm is set, the alt-hover probes ENDPOINTS
    // (head/tail) of every open run (and the closed flavor for the
    // armed run itself, to allow self-join). The same teal ring acts
    // as the snap target; alt-click commits the join with that
    // endpoint as the second pick. Lets the operator drop the join
    // without pixel-precise aim on the small endpoint handle.
    if (tool === 'node') {
      if (e.altKey && (primarySelectedRunId || joinArm)) {
        const w = clientToWorld(e.clientX, e.clientY);
        if (w) {
          const snap = nodeSnapRadiusMM(transform.k, snapEnabled, snapMM);
          let hitRunId: string | null = null;
          let hitIdx: number | null = null;
          let bestD = snap * snap;
          if (joinArm) {
            // Probe every open run's endpoints (and closed-run cases
            // for self-join). Skip the armed endpoint itself — joining
            // an end to itself is a no-op.
            //
            // Tier 3 #33c — hidden + locked runs are skipped: a hidden
            // run can't be a join target (no visual handle to aim at),
            // and a locked run shouldn't accept canvas-driven edits.
            for (const run of doc.runs) {
              if (!isRunVisible(run)) continue;
              if (isRunLocked(run)) continue;
              const n = run.polyline.points.length;
              if (n < 2) continue;
              if (run.polyline.closed && run.id !== joinArm.runId) continue;
              for (const ep of [0, n - 1]) {
                if (run.id === joinArm.runId) {
                  const armedIdx = joinArm.endpoint === 'head' ? 0 : n - 1;
                  if (ep === armedIdx) continue;
                }
                const p = run.polyline.points[ep];
                const dx = p[0] - w[0];
                const dy = p[1] - w[1];
                const d = dx * dx + dy * dy;
                if (d <= bestD) {
                  bestD = d;
                  hitRunId = run.id;
                  hitIdx = ep;
                }
              }
            }
          } else {
            const run = doc.runs.find((r) => r.id === primarySelectedRunId);
            if (run) {
              const hit = nearestVertexWithin(run.polyline.points, w, snap);
              if (hit !== null) {
                hitRunId = run.id;
                hitIdx = hit;
              }
            }
          }
          if (hitRunId !== null && hitIdx !== null) {
            if (!hoveredVertex || hoveredVertex.runId !== hitRunId || hoveredVertex.pointIndex !== hitIdx) {
              setHoveredVertex({ runId: hitRunId, pointIndex: hitIdx });
            }
          } else if (hoveredVertex) {
            setHoveredVertex(null);
          }
        }
      } else if (hoveredVertex) {
        // Alt released or run unselected — drop the highlight.
        setHoveredVertex(null);
      }
    }
    // Tier 3 #61 — break-open / move-opening tool hover. Probe every
    // run (not just the selected one — the user may not have selected
    // anything) for a vertex within the snap radius and reuse the
    // node-edit hoveredVertex slot to render the teal ring. This is
    // the same hit-test the click handler runs, so the visual cue
    // and the action are guaranteed to agree.
    if (tool === 'break-open') {
      const w = clientToWorld(e.clientX, e.clientY);
      if (w) {
        const snap = nodeSnapRadiusMM(transform.k, snapEnabled, snapMM);
        let bestRun: string | null = null;
        let bestIdx: number | null = null;
        let bestD = snap * snap;
        for (const run of doc.runs) {
          // Tier 3 #33c — hidden + locked runs don't accept break-open
          // hovers / clicks. Skip them entirely from the snap probe.
          if (!isRunVisible(run)) continue;
          if (isRunLocked(run)) continue;
          for (let i = 0; i < run.polyline.points.length; i++) {
            const p = run.polyline.points[i];
            const dx = p[0] - w[0];
            const dy = p[1] - w[1];
            const d = dx * dx + dy * dy;
            if (d <= bestD) {
              bestD = d;
              bestRun = run.id;
              bestIdx = i;
            }
          }
        }
        if (bestRun !== null && bestIdx !== null) {
          if (!hoveredVertex || hoveredVertex.runId !== bestRun || hoveredVertex.pointIndex !== bestIdx) {
            setHoveredVertex({ runId: bestRun, pointIndex: bestIdx });
          }
        } else if (hoveredVertex) {
          setHoveredVertex(null);
        }
      }
    }
    // Tier 3 #60 — connect-tubes pointer tracking. Only meaningful
    // when a source is staged; the rendered live-preview line draws
    // from the source electrode position to the cursor.
    if (tool === 'connect' && connectStaged !== null) {
      const w = clientToWorld(e.clientX, e.clientY);
      if (w) setConnectHover(w);
    } else if (connectHover !== null && tool !== 'connect') {
      setConnectHover(null);
    }
    // Tier 3 #48 — rubber-band live drag. Update `current` so the
    // dashed rect repaints; the actual selection commits on pointer-up.
    if (rubberBand) {
      const w = clientToWorld(e.clientX, e.clientY);
      if (w) {
        setRubberBand((prev) =>
          prev && (prev.current[0] !== w[0] || prev.current[1] !== w[1])
            ? { ...prev, current: w }
            : prev,
        );
      }
      return;
    }
    if (drawing.tool === 'rect' && drawing.firstCorner !== null) {
      // Rect second corner: geometry snap probes existing vertices/
      // midpoints first; if shift is held, the working corner is
      // post-processed to W=H (a square, sign-preserved relative to
      // the first corner). Grid snap applies as the fallback inside
      // `drawSnap` when neither geometry nor angle fires; for rect we
      // skip the angle path (a "rect along an axis" doesn't have a
      // single direction-from-anchor — squareness is the analog).
      const raw = drawSnap(e.clientX, e.clientY, null);
      if (raw) {
        let w: [number, number] = raw;
        if (isShiftHeld) {
          const a = drawing.firstCorner;
          const dx = raw[0] - a[0];
          const dy = raw[1] - a[1];
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          w = [a[0] + Math.sign(dx || 1) * side, a[1] + Math.sign(dy || 1) * side];
        }
        setShapeCurrent(w);
      }
      return;
    }
    if (drawing.tool === 'circle' && drawing.center !== null) {
      // Circle radius point: anchor is the center, so Shift locks the
      // radius vector to the nearest 15° axis. Geometry-snap still
      // wins outright if the cursor is near an existing vertex/midpoint.
      const w = drawSnap(e.clientX, e.clientY, drawing.center);
      if (w) setShapeCurrent(w);
      return;
    }
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragRef.current.moved = true;
      setTransform((t) => ({ ...t, tx: dragRef.current!.tx + dx, ty: dragRef.current!.ty + dy }));
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    // Tier 3 #48 — commit rubber-band vertex selection. Walk the
    // primary-selected run's polyline and mark every vertex inside the
    // anchored rect (in world space). Shift held when the rubber-band
    // started toggles into the existing selection; otherwise it
    // replaces. A degenerate (anchor === current) rubber-band just
    // clears the slice — same as a plain background click.
    if (rubberBand) {
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      const rb = rubberBand;
      setRubberBand(null);
      const run = doc.runs.find((r) => r.id === rb.runId);
      if (run) {
        const minX = Math.min(rb.anchor[0], rb.current[0]);
        const maxX = Math.max(rb.anchor[0], rb.current[0]);
        const minY = Math.min(rb.anchor[1], rb.current[1]);
        const maxY = Math.max(rb.anchor[1], rb.current[1]);
        // A degenerate (zero-area) rubber-band is a no-op: the operator
        // probably cmd-clicked on empty canvas to deselect, not to
        // marquee-select an empty rect.
        if (maxX - minX > 0 || maxY - minY > 0) {
          const inside = new Set<number>();
          for (let i = 0; i < run.polyline.points.length; i++) {
            const p = run.polyline.points[i];
            if (p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY) {
              inside.add(i);
            }
          }
          setSelectedVertices((prev) => {
            if (rb.additive && prev && prev.runId === rb.runId) {
              const merged = new Set(prev.indices);
              for (const i of inside) merged.add(i);
              if (merged.size === 0) return null;
              return { runId: rb.runId, indices: merged };
            }
            if (inside.size === 0) return null;
            return { runId: rb.runId, indices: inside };
          });
        }
      }
      return;
    }
    // Rect / circle: pointer-up commits the drawn shape. We require a
    // minimum drag distance (1mm in world space) so an accidental click
    // doesn't emit a degenerate run.
    const shapeAnchor =
      drawing.tool === 'rect' ? drawing.firstCorner :
      drawing.tool === 'circle' ? drawing.center : null;
    if (shapeAnchor !== null && (drawing.tool === 'rect' || drawing.tool === 'circle')) {
      const a = shapeAnchor;
      const b = shapeCurrent ?? a;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      dispatch({ type: drawing.tool === 'rect' ? 'rectCommit' : 'circleCommit' });
      setShapeCurrent(null);
      if (drawing.tool === 'rect') {
        const w = Math.abs(a[0] - b[0]);
        const h = Math.abs(a[1] - b[1]);
        if (w >= 1 && h >= 1) onCommitShape('rect', rectToPoints(a[0], a[1], b[0], b[1]), true);
      } else {
        const r = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (r >= 1) onCommitShape('circle', circleToPoints(a[0], a[1], r, 64), true);
      }
      return;
    }
    if (dragRef.current) {
      const wasDrag = dragRef.current.moved;
      dragRef.current = null;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // pointer might have been released already
      }
      if (wasDrag) return;
    }
    const tag = (e.target as SVGElement).tagName;
    const isBackground = tag === 'svg' || tag === 'rect';
    // Tier 3 #48 — alt-click during join-arm second pick. The same
    // snap-to-vertex hover ring (Tier 3 #25) telegraphs which endpoint
    // will be picked; alt-click commits the join with that endpoint
    // even if the operator missed the small endpoint NodeHandle
    // hitbox. Plain (non-alt) clicks still go through the NodeHandle
    // onPlainClick path so this only triggers on the explicit modifier.
    if (tool === 'node' && joinArm && e.altKey && hoveredVertex) {
      const run = doc.runs.find((r) => r.id === hoveredVertex.runId);
      if (run) {
        const n = run.polyline.points.length;
        // Map polyline index → endpoint label. We only ever set
        // hoveredVertex to head/tail in the join-arm branch above, so
        // the tail-vs-head check is a defensive sanity guard.
        const ep: 'head' | 'tail' | null =
          hoveredVertex.pointIndex === 0 ? 'head'
          : hoveredVertex.pointIndex === n - 1 ? 'tail'
          : null;
        if (ep) {
          onPickJoinEndpoint(hoveredVertex.runId, ep);
          setHoveredVertex(null);
          return;
        }
      }
    }
    // Background click in label/dimension mode places a marker in world
    // space; in any other mode it deselects the current run.
    if (tool === 'label' && isBackground) {
      const world = clientToWorldSnapped(e.clientX, e.clientY);
      if (world) onPlaceLabel(world[0], world[1]);
      return;
    }
    if (tool === 'dimension' && isBackground) {
      const world = clientToWorldSnapped(e.clientX, e.clientY);
      if (!world) return;
      if (!stagedDim) {
        setStagedDim({ x: world[0], y: world[1] });
      } else {
        onPlaceDimension(stagedDim.x, stagedDim.y, world[0], world[1]);
        setStagedDim(null);
      }
      return;
    }
    if (drawing.tool === 'pen' && isBackground) {
      // Click drops a vertex; double-click is detected via React's
      // onDoubleClick handler on the SVG so we keep the dispatch local.
      // Anchor for angle-snap is the previous vertex (none for the
      // first click, in which case angle snap is silently a no-op).
      const lastVertex =
        drawing.vertices.length > 0 ? drawing.vertices[drawing.vertices.length - 1] : null;
      const world = drawSnap(e.clientX, e.clientY, lastVertex);
      if (!world) return;
      dispatch({ type: 'penVertex', point: world });
      setPenHover(world);
      return;
    }
    if (drawing.tool === 'arc' && isBackground) {
      // Same anchor logic as the pointermove preview: latest placed
      // click acts as the angle-snap anchor for the next click.
      const arcAnchor = drawing.secondClick ?? drawing.firstClick;
      const world = drawSnap(e.clientX, e.clientY, arcAnchor);
      if (!world) return;
      if (drawing.firstClick === null) {
        // Click 1 — drop firstClick and start preview tracking.
        dispatch({ type: 'arcFirstClick', point: world });
        setArcHover(world);
      } else if (drawing.secondClick === null) {
        // Click 2 — drop secondClick.
        dispatch({ type: 'arcSecondClick', point: world });
        setArcHover(world);
      } else {
        // Click 3 — commit the arc through (firstClick, secondClick,
        // world). The helper handles the degenerate-collinear fallback.
        const pts = threePointArcToPoints(drawing.firstClick, drawing.secondClick, world, 3);
        onCommitShape('arc', pts, false);
        dispatch({ type: 'arcCommit' });
        setArcHover(null);
      }
      return;
    }
    if (isBackground) {
      onSelectRun(null);
    }
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (drawing.tool !== 'pen') return;
    const tag = (e.target as SVGElement).tagName;
    if (tag !== 'svg' && tag !== 'rect') return;
    // Double-click also fires the underlying single click first, so by
    // the time React re-renders, the reducer's `vertices` already has
    // the extra entry from `penVertex`. Read it directly off `drawing`
    // and commit if we now have ≥2 vertices, otherwise quietly cancel.
    e.preventDefault();
    if (drawing.vertices.length >= 2) {
      onCommitShape('pen', drawing.vertices.slice(), false);
    }
    dispatch({ type: 'penCommit' });
    setPenHover(null);
  }

  function onRunClick(e: React.MouseEvent<SVGPathElement>, run: DesignRun) {
    e.stopPropagation();
    if (dragRef.current?.moved) return;
    if (tool === 'electrode') {
      const world = clientToWorld(e.clientX, e.clientY);
      if (!world) return;
      const idx = nearestPointIndex(run.polyline.points, world);
      onPlaceElectrode(run.id, idx);
      return;
    }
    if (tool === 'blockout') {
      const world = clientToWorld(e.clientX, e.clientY);
      if (!world) return;
      const arcs = runArcs(run);
      if (arcs.live.length < 2) return;
      const liveIdx = nearestLiveArcIndex(arcs.live, run.polyline.points, world);
      // Clicking a different run resets the staged start onto the new run.
      if (!staged || staged.runId !== run.id) {
        setStaged({ runId: run.id, liveIndex: liveIdx });
        onSelectRun(run.id);
        return;
      }
      // Same run, second click → commit.
      onPlaceBlockout(run.id, staged.liveIndex, liveIdx);
      setStaged(null);
      return;
    }
    if (tool === 'jump' || tool === 'support' || tool === 'doubleback') {
      const world = clientToWorld(e.clientX, e.clientY);
      if (!world) return;
      const arcs = runArcs(run);
      if (arcs.live.length < 1) return;
      const liveIdx = nearestLiveArcIndex(arcs.live, run.polyline.points, world);
      onPlaceAnnotation(run.id, tool, liveIdx);
      onSelectRun(run.id);
      return;
    }
    if (tool === 'bend') {
      const world = clientToWorld(e.clientX, e.clientY);
      if (!world) return;
      const arcs = runArcs(run);
      if (arcs.live.length < 1) return;
      const liveIdx = nearestLiveArcIndex(arcs.live, run.polyline.points, world);
      onPlaceBend(run.id, liveIdx);
      onSelectRun(run.id);
      return;
    }
    if (tool === 'insert-doubleback') {
      const world = clientToWorld(e.clientX, e.clientY);
      if (!world) return;
      const { segmentIndex, t } = nearestSegmentT(run.polyline.points, world);
      const side: 'left' | 'right' = e.shiftKey ? 'right' : 'left';
      onInsertDoubleback(run.id, segmentIndex, t, side);
      onSelectRun(run.id);
      setDbHover(null);
      return;
    }
    if (tool === 'break-open') {
      // Tier 3 #61 — click within snap radius of a vertex commits the
      // appropriate op based on the run's `closed` flag. Outside the
      // snap radius is a no-op (the cursor wasn't pointing at a vertex
      // yet). We re-test the hit here rather than trusting hoveredVertex
      // alone so a click with no preceding mousemove (e.g. via keyboard)
      // still routes correctly.
      const world = clientToWorld(e.clientX, e.clientY);
      if (!world) return;
      const snap = nodeSnapRadiusMM(transform.k, snapEnabled, snapMM);
      const hit = nearestVertexWithin(run.polyline.points, world, snap);
      if (hit === null) {
        onSelectRun(run.id);
        return;
      }
      if (run.polyline.closed) {
        onBreakOpen(run.id, hit);
      } else if ((run.electrodes?.length ?? 0) === 2) {
        onMoveOpening(run.id, hit);
      } else {
        // Open run without two electrodes — nothing meaningful to move.
        // Just select so the operator can place electrodes first.
        onSelectRun(run.id);
        return;
      }
      onSelectRun(run.id);
      setHoveredVertex(null);
      return;
    }
    if (tool === 'node') {
      // Alt-click on the polyline (not on a vertex handle) inserts a new
      // vertex at the click point. The selected run must match the
      // clicked run; otherwise just select the new run so the user can
      // see its existing vertices first.
      if (e.altKey && run.id === primarySelectedRunId) {
        // Note: alt-click reuses the primary selection only — we don't
        // want a stray multi-select to fire vertex inserts on every run.
        const world = clientToWorld(e.clientX, e.clientY);
        if (!world) return;
        // Tier 3 #25 — if the click landed within the snap-to-vertex
        // radius of an existing vertex, skip the insert (would be a
        // 0-distance duplicate). The hover ring already telegraphs this
        // visually; clicking is a no-op for a smoother UX. We re-test
        // the snap here rather than trusting hoveredVertex alone, so a
        // click without a preceding mousemove (e.g. via keyboard) still
        // gets the dedup.
        const snap = nodeSnapRadiusMM(transform.k, snapEnabled, snapMM);
        if (nearestVertexWithin(run.polyline.points, world, snap) !== null) {
          return;
        }
        const { segmentIndex, t } = nearestSegmentT(run.polyline.points, world);
        onInsertVertex(run.id, segmentIndex, t);
        return;
      }
      onSelectRun(run.id);
      return;
    }
    // Tier 3 #33a — Shift / Cmd-Ctrl-click toggles the run in/out of
    // the multi-select. Plain click replaces the selection. The
    // modifier check lives only on this default branch — tool-specific
    // clicks above (electrode placement, blockout, jump/support, bend,
    // insert-doubleback, break-open) all want the legacy "set selection
    // to clicked run" behavior so the active tool's followup operates
    // on a single run as before.
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    onSelectRun(run.id, { additive });
  }

  // Track which segment the cursor is closest to while the
  // insert-doubleback tool is active. Dispatched from the run's hit-path
  // pointer-move so we only update on hover over a real run.
  function onRunPointerMoveForDB(e: React.PointerEvent<SVGPathElement>, run: DesignRun) {
    if (tool !== 'insert-doubleback') return;
    const world = clientToWorld(e.clientX, e.clientY);
    if (!world) return;
    const { segmentIndex, t } = nearestSegmentT(run.polyline.points, world);
    const side: 'left' | 'right' = e.shiftKey ? 'right' : 'left';
    setDbHover((prev) =>
      prev && prev.runId === run.id && prev.segmentIndex === segmentIndex && Math.abs(prev.t - t) < 1e-3 && prev.side === side
        ? prev
        : { runId: run.id, segmentIndex, t, side },
    );
  }

  function onAnnotationClick(e: React.MouseEvent, runId: string, annotationIndex: number) {
    e.stopPropagation();
    if (dragRef.current?.moved) return;
    onSelectRun(runId);
    if (tool === 'select' && (e.shiftKey || e.altKey)) {
      onDeleteAnnotation(runId, annotationIndex);
    }
  }

  function onElectrodeClick(e: React.MouseEvent, runId: string, electrodeIndex: number) {
    e.stopPropagation();
    if (dragRef.current?.moved) return;
    // Tier 3 #60 — connect-tubes two-click flow. First click on any
    // electrode stages it as the source; second click on an electrode
    // belonging to a DIFFERENT run commits a jumper. Same-run second
    // clicks no-op (would self-jumper); same-electrode clicks no-op
    // too. The committer is responsible for clearing the staged source
    // (we do that here so a thrown OperationError on the parent's side
    // doesn't strand a stale source — it'll be cleared regardless).
    if (tool === 'connect') {
      if (connectStaged === null) {
        setConnectStaged({ runId, electrodeIndex });
        onSelectRun(runId);
        return;
      }
      if (connectStaged.runId === runId) {
        // Re-click the source electrode → cancel; re-click a different
        // electrode on the same run → also a no-op (V1 forbids self-
        // jumpers, and the operator probably mis-clicked).
        if (connectStaged.electrodeIndex === electrodeIndex) {
          setConnectStaged(null);
          setConnectHover(null);
        }
        return;
      }
      onConnectTubes(
        connectStaged.runId,
        connectStaged.electrodeIndex,
        runId,
        electrodeIndex,
      );
      setConnectStaged(null);
      setConnectHover(null);
      return;
    }
    onSelectRun(runId);
    if (tool === 'select' && (e.shiftKey || e.altKey)) {
      onDeleteElectrode(runId, electrodeIndex);
    }
  }

  function fitToView() {
    if (size.w === 0 || size.h === 0) return;
    const [x, y, w, h] = doc.view_box_mm;
    const padding = 0.9;
    const scale = Math.min(size.w / w, size.h / h) * padding;
    setTransform({
      k: scale,
      tx: size.w / 2 - (x + w / 2) * scale,
      ty: size.h / 2 - (y + h / 2) * scale,
    });
  }

  // Marker size: 10 device pixels regardless of zoom.
  const markerSizeMM = 10 / transform.k;

  // Tier 3 #28 — Validation marker overlay.
  //
  // Filter incoming issues to those with finite world-space coordinates that
  // fall within the document bounding box (padded ±10 mm). Off-canvas issues
  // (usually data artifacts from earlier rule versions) clutter the canvas
  // without informing the user, so we drop them at this stage. Memoized on
  // `validationIssues` and `doc.view_box_mm` so the geometry only recomputes
  // when the report or canvas bounds change — pan/zoom doesn't invalidate.
  const visibleIssues = useMemo(() => {
    if (!validationIssues || validationIssues.length === 0) return [];
    const [bx, by, bw, bh] = doc.view_box_mm;
    const x0 = bx - 10;
    const y0 = by - 10;
    const x1 = bx + bw + 10;
    const y1 = by + bh + 10;
    const showErrors = issueSeverityFilter?.errors ?? true;
    const showWarnings = issueSeverityFilter?.warnings ?? true;
    // Track the GLOBAL index INTO `validationIssues` so hover events
    // and the highlight-by-index work in the same index space the
    // sidebar uses (i.e. indices into report.issues).
    const out: { issue: ValidationIssue; x: number; y: number; idx: number }[] = [];
    for (let i = 0; i < validationIssues.length; i++) {
      const issue = validationIssues[i];
      // Severity filter — applied here so the canvas and sidebar
      // agree on which markers are visible without the parent having
      // to fork the array. The index in `out[].idx` is still the
      // global index, so hover/click stay coherent.
      if (issue.severity === 'error' && !showErrors) continue;
      if (issue.severity === 'warning' && !showWarnings) continue;
      const x = issue.x_mm;
      const y = issue.y_mm;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if ((x as number) < x0 || (x as number) > x1) continue;
      if ((y as number) < y0 || (y as number) > y1) continue;
      out.push({ issue, x: x as number, y: y as number, idx: i });
    }
    return out;
  }, [validationIssues, doc.view_box_mm, issueSeverityFilter]);

  // Per-issue marker radius scales with zoom but never collapses below a
  // legible 4 mm at deep zoom-out. `8 / k` mirrors the snap-handle math
  // elsewhere so the markers feel sized like the rest of the canvas chrome.
  const issueMarkerR = Math.max(8 / transform.k, 4);

  // Find the run whose polyline passes closest to a given world-space
  // point. Used by click-to-select on a marker. Returns `null` when the
  // doc has no runs. We measure to every polyline vertex (cheap; the
  // canvas already does the same in nearestPointIndex for electrode
  // placement); for typical signs (≤ a few thousand vertices total)
  // this is well under a millisecond.
  //
  // Tier 3 #33c — hidden + locked runs are skipped so a background
  // click can't pick a run that the canvas is hiding or click-
  // protecting. The Layers sidebar still lets the user select locked
  // members on purpose (sidebar bypasses the lock).
  function nearestRunId(target: [number, number]): string | null {
    let bestId: string | null = null;
    let bestD = Infinity;
    for (const run of doc.runs) {
      if (!isRunVisible(run)) continue;
      if (isRunLocked(run)) continue;
      for (const p of run.polyline.points) {
        const dx = p[0] - target[0];
        const dy = p[1] - target[1];
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          bestId = run.id;
        }
      }
    }
    return bestId;
  }

  return (
    <div ref={containerRef} className={`editor-canvas tool-${tool}`}>
      <svg
        width="100%"
        height="100%"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => {
          // Tier 3 #60 — right-click anywhere cancels a staged
          // connect-tubes source (matches Esc). Suppressing the
          // browser context menu only inside the connect flow keeps
          // the existing right-click-on-electrode → housing-picker
          // affordance working when the operator isn't connecting.
          if (tool === 'connect' && connectStaged !== null) {
            e.preventDefault();
            setConnectStaged(null);
            setConnectHover(null);
          }
        }}
      >
        <rect x={0} y={0} width={size.w} height={size.h} fill="transparent" />
        <g transform={`translate(${transform.tx},${transform.ty}) scale(${transform.k})`}>
          {/* Tier 3 #33b — pale dashed bbox outline around each group's
              members. Painted UNDER the run strokes so a glowing tube
              still reads as the dominant line. Padding is in
              device-pixel space (so it stays readable at any zoom).
              Color matches the multi-select pink at 50% opacity to
              echo 33a's selection ring without competing with it. */}
          {groupBBoxes.map((b) => {
            const pad = 4 / transform.k;
            return (
              <rect
                key={`group-outline-${b.id}`}
                x={b.minX - pad}
                y={b.minY - pad}
                width={(b.maxX - b.minX) + 2 * pad}
                height={(b.maxY - b.minY) + 2 * pad}
                fill="none"
                stroke="#ff3b6b"
                strokeOpacity={0.5}
                strokeWidth={1 / transform.k}
                strokeDasharray={`${4 / transform.k} ${3 / transform.k}`}
                pointerEvents="none"
              />
            );
          })}
          {doc.runs.map((run) => {
            // Tier 3 #33c — hidden groups skip rendering entirely. No
            // polyline, no electrodes, no blockouts, no selection ring.
            // Validation / save / PDF / DXF still see the run; this
            // is a *display* filter only.
            if (!isRunVisible(run)) return null;
            const locked = isRunLocked(run);
            const selected = primarySelectedRunIdSet.has(run.id);
            const arcs = runArcs(run);
            const inactiveD = arcs.inactive.length > 1
              ? indicesToD(arcs.inactive, run.polyline.points, false)
              : '';
            const segs = blockoutSegments(arcs.live, run.blockouts, arcs.liveClosed);
            const liveStroke = colorHex(run.color);
            const liveWidth = (selected ? 1.6 : 0.8) / transform.k;
            // Hit zone for clicks: ~12 device pixels wide regardless of zoom,
            // so picking electrodes / blockouts / annotations doesn't require
            // landing exactly on the 1-pixel visible stroke.
            const hitWidth = 12 / transform.k;
            const cursor =
              tool === 'select' ? 'pointer' : 'crosshair';
            // When a colored run is selected we still want a clear selection
            // signal, so draw a wider semi-transparent pink halo underneath.
            const liveD = indicesToD(arcs.live, run.polyline.points, arcs.liveClosed);
            return (
              <g key={run.id}>
                {inactiveD && (
                  <path
                    d={inactiveD}
                    stroke="#aaa"
                    strokeWidth={0.4 / transform.k}
                    strokeDasharray={`${2 / transform.k} ${1.5 / transform.k}`}
                    fill="none"
                    pointerEvents="none"
                  />
                )}
                {selected && (
                  <path
                    d={liveD}
                    stroke="#ff3b6b"
                    strokeWidth={3.2 / transform.k}
                    // Locked-but-selected runs (selection survives a
                    // lock toggle — see EditorPage's selection invariants)
                    // render the halo at 50% the normal opacity so the
                    // user sees at a glance that further canvas clicks
                    // won't pick this run.
                    strokeOpacity={locked ? 0.18 : 0.35}
                    fill="none"
                    pointerEvents="none"
                  />
                )}
                {/* Hit-target stroke: invisible but pointer-events="stroke"
                    so SVG hit-tests it regardless of paint. Wide enough
                    that clicks don't have to land on the 1px visible line.
                    Layered under the visible strokes so the latter render
                    on top.

                    Tier 3 #33c — locked-group runs disable pointer-events
                    here so canvas clicks fall through to whatever is
                    behind. The Layers sidebar bypasses the lock with its
                    own click handler, so the operator can still select
                    locked-group members on purpose. */}
                <path
                  d={liveD}
                  stroke="black"
                  strokeOpacity={0}
                  strokeWidth={hitWidth}
                  fill="none"
                  pointerEvents={locked ? 'none' : 'stroke'}
                  onClick={(e) => onRunClick(e, run)}
                  onPointerMove={(e) => onRunPointerMoveForDB(e, run)}
                  onPointerLeave={() => {
                    if (tool === 'insert-doubleback') setDbHover(null);
                  }}
                  style={{ cursor }}
                />
                {segs.map((seg, si) => {
                  const d = indicesToD(
                    seg.liveIndices,
                    run.polyline.points,
                    arcs.liveClosed && segs.length === 1 && !seg.isBlockout,
                  );
                  if (seg.isBlockout) {
                    // Blockouts are painted-out tube — they don't glow, so
                    // render them in the neutral stroke even when the run
                    // has a gas color assigned.
                    return (
                      <path
                        key={`bo-${si}`}
                        d={d}
                        stroke="#222"
                        strokeWidth={liveWidth}
                        strokeDasharray={`${1.6 / transform.k} ${1 / transform.k}`}
                        fill="none"
                        pointerEvents="none"
                      />
                    );
                  }
                  // Tier 3 #60 — jumper runs render with a dashed
                  // stroke on the 2D pattern (matches print PDF and
                  // distinguishes them visually from primary tubes).
                  const isJumper = run.kind === 'jumper';
                  return (
                    <path
                      key={`alive-${si}`}
                      d={d}
                      stroke={liveStroke}
                      strokeWidth={liveWidth}
                      strokeDasharray={
                        isJumper
                          ? `${2 / transform.k} ${1 / transform.k}`
                          : undefined
                      }
                      fill="none"
                      pointerEvents="none"
                    />
                  );
                })}
              </g>
            );
          })}
          {(doc.dimensions ?? []).map((d, di) => (
            <DimensionMarker
              key={`dim-${di}`}
              x1={d.x1}
              y1={d.y1}
              x2={d.x2}
              y2={d.y2}
              note={d.note}
              k={transform.k}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey || e.altKey) onDeleteDimension(di);
              }}
            />
          ))}
          {(doc.labels ?? []).map((l, li) => (
            <LabelMarker
              key={`label-${li}`}
              x={l.x}
              y={l.y}
              text={l.text}
              k={transform.k}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey || e.altKey) onDeleteLabel(li);
              }}
            />
          ))}
          {stagedDim && (
            <circle
              cx={stagedDim.x}
              cy={stagedDim.y}
              r={6 / transform.k}
              fill="none"
              stroke="#ff8a00"
              strokeWidth={2 / transform.k}
              pointerEvents="none"
            />
          )}
          {/* Drawing-tool previews. Rendered in the existing staged-marker
              orange so the user can tell at a glance the geometry isn't
              committed yet. Stroke widths and handle radii scale with the
              zoom transform so they stay visible. */}
          {drawing.tool === 'pen' && drawing.vertices.length > 0 && (() => {
            const vertices = drawing.vertices;
            const sample: [number, number][] = penHover ? [...vertices, penHover] : vertices;
            const d = sample
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`)
              .join(' ');
            return (
              <g>
                <path
                  d={d}
                  stroke="#ff8a00"
                  strokeWidth={1.6 / transform.k}
                  strokeDasharray={`${3 / transform.k} ${2 / transform.k}`}
                  fill="none"
                  pointerEvents="none"
                />
                {vertices.map((p, i) => (
                  <circle
                    key={`pen-v-${i}`}
                    cx={p[0]}
                    cy={p[1]}
                    r={3 / transform.k}
                    fill="#ff8a00"
                    pointerEvents="none"
                  />
                ))}
              </g>
            );
          })()}
          {drawing.tool === 'rect' && drawing.firstCorner !== null && shapeCurrent !== null && (() => {
            const a = drawing.firstCorner;
            const b = shapeCurrent;
            const xMin = Math.min(a[0], b[0]);
            const yMin = Math.min(a[1], b[1]);
            const w = Math.abs(a[0] - b[0]);
            const h = Math.abs(a[1] - b[1]);
            return (
              <rect
                x={xMin}
                y={yMin}
                width={w}
                height={h}
                stroke="#ff8a00"
                strokeWidth={1.6 / transform.k}
                strokeDasharray={`${3 / transform.k} ${2 / transform.k}`}
                fill="none"
                pointerEvents="none"
              />
            );
          })()}
          {drawing.tool === 'circle' && drawing.center !== null && shapeCurrent !== null && (() => {
            const a = drawing.center;
            const b = shapeCurrent;
            const r = Math.hypot(a[0] - b[0], a[1] - b[1]);
            return (
              <g pointerEvents="none">
                <circle
                  cx={a[0]}
                  cy={a[1]}
                  r={r}
                  stroke="#ff8a00"
                  strokeWidth={1.6 / transform.k}
                  strokeDasharray={`${3 / transform.k} ${2 / transform.k}`}
                  fill="none"
                />
                <circle
                  cx={a[0]}
                  cy={a[1]}
                  r={3 / transform.k}
                  fill="#ff8a00"
                />
              </g>
            );
          })()}
          {drawing.tool === 'arc' && drawing.firstClick !== null && (() => {
            // Live arc preview: with 1 anchor, just show a marker. With
            // 2 anchors (or 1 + hover) draw a line; with 3 (2 anchors +
            // hover), draw a candidate arc through the trio.
            const anchors: [number, number][] = drawing.secondClick !== null
              ? [drawing.firstClick, drawing.secondClick]
              : [drawing.firstClick];
            const pts: [number, number][] = arcHover ? [...anchors, arcHover] : anchors;
            let d = '';
            if (pts.length === 2) {
              d = `M${pts[0][0]} ${pts[0][1]} L${pts[1][0]} ${pts[1][1]}`;
            } else if (pts.length === 3) {
              const sampled = threePointArcToPoints(pts[0], pts[1], pts[2], 3);
              d = sampled.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`).join(' ');
            }
            return (
              <g pointerEvents="none">
                {d && (
                  <path
                    d={d}
                    stroke="#ff8a00"
                    strokeWidth={1.6 / transform.k}
                    strokeDasharray={`${3 / transform.k} ${2 / transform.k}`}
                    fill="none"
                  />
                )}
                {anchors.map((p, i) => (
                  <circle
                    key={`arc-v-${i}`}
                    cx={p[0]}
                    cy={p[1]}
                    r={3 / transform.k}
                    fill="#ff8a00"
                  />
                ))}
              </g>
            );
          })()}
          {/* Tier 3 #34 — angle-snap guide line. While Shift is held
              during an in-progress drawing tool, draw a thin dashed
              gray radial line from the active anchor through the
              snapped cursor so the user can see the locked direction
              live. Length extends past the cursor so the angle reads
              as a continuous ray, not a tick mark. Subtle: 1px stroke
              and a low-contrast color so the active shape preview
              stays the dominant visual. */}
          {isShiftHeld && (() => {
            // Pick the working anchor + working point per active tool.
            // Skipped (anchor null) when there's nothing yet to lock to.
            let anchor: [number, number] | null = null;
            let working: [number, number] | null = null;
            if (drawing.tool === 'pen' && drawing.vertices.length > 0 && penHover) {
              anchor = drawing.vertices[drawing.vertices.length - 1];
              working = penHover;
            } else if (drawing.tool === 'circle' && drawing.center !== null && shapeCurrent) {
              anchor = drawing.center;
              working = shapeCurrent;
            } else if (drawing.tool === 'arc' && drawing.firstClick !== null && arcHover) {
              anchor = drawing.secondClick ?? drawing.firstClick;
              working = arcHover;
            }
            // Rect uses square-constraint (not radial angle-lock), so
            // no guide line for it — the live preview already shows the
            // square outline as feedback.
            if (!anchor || !working) return null;
            const dx = working[0] - anchor[0];
            const dy = working[1] - anchor[1];
            const len = Math.hypot(dx, dy);
            if (!(len > 0)) return null;
            const ux = dx / len;
            const uy = dy / len;
            const extend = len * 2;
            return (
              <line
                x1={anchor[0]}
                y1={anchor[1]}
                x2={anchor[0] + ux * extend}
                y2={anchor[1] + uy * extend}
                stroke="#888"
                strokeWidth={1 / transform.k}
                strokeDasharray={`${4 / transform.k} ${3 / transform.k}`}
                pointerEvents="none"
              />
            );
          })()}
          {/* Tier 3 #34 — geometry-snap hover ring. Same teal-on-no-fill
              treatment as the node-edit alt-hover (Tier 3 #25) so the
              two snap modes share a visual vocabulary. Renders during
              ANY in-progress drawing tool when the cursor is within
              snap range of an existing vertex or segment midpoint. */}
          {geometryHover && (drawing.tool === 'pen' || drawing.tool === 'rect' || drawing.tool === 'circle' || drawing.tool === 'arc') && (
            <circle
              cx={geometryHover.point[0]}
              cy={geometryHover.point[1]}
              r={8 / transform.k}
              fill="none"
              stroke="#1aa37a"
              strokeWidth={6 / transform.k}
              strokeOpacity={0.75}
              pointerEvents="none"
            />
          )}
          {tool === 'insert-doubleback' && dbHover && (() => {
            const run = doc.runs.find((r) => r.id === dbHover.runId);
            if (!run) return null;
            const pts = run.polyline.points;
            const seg = dbHover.segmentIndex;
            if (seg < 0 || seg >= pts.length - 1) return null;
            const tubeDiam = run.tube_diameter_mm ?? projectDiameterMM;
            const depth = 1.5 * tubeDiam;
            const gap = 1.0 * tubeDiam;
            const verts = doublebackPreviewVertices(
              pts[seg],
              pts[seg + 1],
              dbHover.t,
              depth,
              gap,
              dbHover.side,
            );
            if (!verts) return null;
            // Build the same polyline that the helper would splice in:
            // p1 → A → B → C → D → p2.
            const path = [pts[seg], ...verts, pts[seg + 1]];
            const d = path
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]} ${p[1]}`)
              .join(' ');
            return (
              <g pointerEvents="none">
                <path
                  d={d}
                  stroke="#ff8a00"
                  strokeWidth={1.6 / transform.k}
                  strokeDasharray={`${3 / transform.k} ${2 / transform.k}`}
                  fill="none"
                />
                {verts.map((p, i) => (
                  <circle
                    key={`db-v-${i}`}
                    cx={p[0]}
                    cy={p[1]}
                    r={3 / transform.k}
                    fill="#ff8a00"
                  />
                ))}
              </g>
            );
          })()}
          {staged && (() => {
            const run = doc.runs.find((r) => r.id === staged.runId);
            if (!run) return null;
            const arcs = runArcs(run);
            const polyIdx = arcs.live[staged.liveIndex];
            const p = polyIdx != null ? run.polyline.points[polyIdx] : null;
            if (!p) return null;
            const r = (6 / transform.k);
            return (
              <circle
                cx={p[0]}
                cy={p[1]}
                r={r}
                fill="none"
                stroke="#ff8a00"
                strokeWidth={2 / transform.k}
                pointerEvents="none"
              />
            );
          })()}
          {/* Tier 3 #60 — Connect Tubes overlays.
              1) When the connect tool is active, every electrode pin
                 gets a teal ring underneath signaling "this is a valid
                 click target".
              2) The currently-hovered electrode (any run) lights up
                 brighter so the operator can see which one will be
                 picked.
              3) A staged source electrode pulses green, and a dashed
                 line draws from it to the cursor so the operator can
                 see the candidate jumper before committing. */}
          {tool === 'connect' && (
            <g pointerEvents="none">
              {doc.runs.flatMap((run) => {
                // Tier 3 #33c — hidden runs aren't drawn, so their
                // electrodes shouldn't show as connect-tool targets.
                // Locked runs are still picked here: connecting two
                // already-laid-out tube ends doesn't break the lock
                // model (the lock is a click-protect, not an edit-
                // protect; click is *via this overlay* on purpose).
                if (!isRunVisible(run)) return [];
                return (run.electrodes ?? []).map((e, ei) => {
                  const p = run.polyline.points[e.point_index];
                  if (!p) return null;
                  const isStaged =
                    connectStaged !== null &&
                    connectStaged.runId === run.id &&
                    connectStaged.electrodeIndex === ei;
                  const isHov =
                    hoveredElectrode !== null &&
                    hoveredElectrode.runId === run.id &&
                    hoveredElectrode.electrodeIndex === ei;
                  // Staged source: solid green pulse-style ring (uses
                  // the same #1aa37a color the join-arming flow picked
                  // for "active click target", just sized larger so
                  // the source reads distinct from the candidates).
                  // Hovered candidate: same teal but slightly heavier.
                  // Idle candidate: thin teal so it doesn't visually
                  // dominate the underlying pink electrode marker.
                  const stroke = isStaged ? '#22c55e' : '#1aa37a';
                  const baseR = (isStaged ? 9 : isHov ? 8 : 6) / transform.k;
                  const sw = (isStaged ? 3 : isHov ? 2.5 : 1.5) / transform.k;
                  return (
                    <circle
                      key={`connect-ring-${run.id}-${ei}`}
                      cx={p[0]}
                      cy={p[1]}
                      r={baseR}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={sw}
                      strokeOpacity={isStaged ? 0.95 : isHov ? 0.85 : 0.55}
                    />
                  );
                });
              })}
              {connectStaged !== null && connectHover !== null && (() => {
                const run = doc.runs.find((r) => r.id === connectStaged.runId);
                const electrode = run?.electrodes?.[connectStaged.electrodeIndex];
                if (!run || !electrode) return null;
                const p = run.polyline.points[electrode.point_index];
                if (!p) return null;
                return (
                  <line
                    x1={p[0]}
                    y1={p[1]}
                    x2={connectHover[0]}
                    y2={connectHover[1]}
                    stroke="#22c55e"
                    strokeWidth={1.2 / transform.k}
                    strokeDasharray={`${2 / transform.k} ${1.5 / transform.k}`}
                    strokeOpacity={0.85}
                  />
                );
              })()}
            </g>
          )}
          {doc.runs.flatMap((run) => {
            // Tier 3 #33c — hidden runs render no electrode markers.
            // Locked runs DO show electrode markers (so the user can
            // see the existing tube layout) but those markers ignore
            // canvas clicks for selection — see ElectrodeMarker's
            // own pointer-events handling below.
            if (!isRunVisible(run)) return [];
            const lockedRun = isRunLocked(run);
            return (run.electrodes ?? []).map((e, ei) => {
              const p = run.polyline.points[e.point_index];
              if (!p) return null;
              const isHovered =
                hoveredElectrode !== null &&
                hoveredElectrode.runId === run.id &&
                hoveredElectrode.electrodeIndex === ei;
              return (
                <ElectrodeMarker
                  key={`${run.id}-${ei}`}
                  x={p[0]}
                  y={p[1]}
                  sizeMM={markerSizeMM}
                  showGear={isHovered && !!onElectrodeContextMenu && !lockedRun}
                  onClick={lockedRun ? undefined : (ev) => onElectrodeClick(ev, run.id, ei)}
                  onContextMenu={
                    onElectrodeContextMenu && !lockedRun
                      ? (ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          onElectrodeContextMenu(run.id, ei);
                        }
                      : undefined
                  }
                  onPointerEnter={
                    lockedRun
                      ? undefined
                      : () => setHoveredElectrode({ runId: run.id, electrodeIndex: ei })
                  }
                  onPointerLeave={
                    lockedRun
                      ? undefined
                      : () => {
                          setHoveredElectrode((prev) =>
                            prev && prev.runId === run.id && prev.electrodeIndex === ei
                              ? null
                              : prev,
                          );
                        }
                  }
                />
              );
            });
          })}
          {primarySelectedRunId &&
            (() => {
              const run = doc.runs.find((r) => r.id === primarySelectedRunId);
              if (!run) return null;
              const bends = effectiveBends(run, projectDiameterMM);
              const isManual = !!run.bends && run.bends.length > 0;
              return bends.map((b, bi) => (
                <BendMarker
                  key={`bend-${primarySelectedRunId}-${bi}`}
                  x={b.x}
                  y={b.y}
                  sizeMM={markerSizeMM * 0.6}
                  manual={isManual}
                />
              ));
            })()}
          {/* Tier 3 #48 — rubber-band rectangle. Drawn during Cmd/Ctrl+
              drag in node mode while a primary run is selected. Pure
              affordance — the actual selection commits on pointer-up.
              Color matches the canvas's selection-blue family but uses
              a dashed stroke + translucent fill so it reads as
              "marquee", not "shape". */}
          {rubberBand && (() => {
            const minX = Math.min(rubberBand.anchor[0], rubberBand.current[0]);
            const minY = Math.min(rubberBand.anchor[1], rubberBand.current[1]);
            const w = Math.abs(rubberBand.current[0] - rubberBand.anchor[0]);
            const h = Math.abs(rubberBand.current[1] - rubberBand.anchor[1]);
            return (
              <rect
                x={minX}
                y={minY}
                width={w}
                height={h}
                fill="rgba(31, 111, 235, 0.12)"
                stroke="#1f6feb"
                strokeWidth={1 / transform.k}
                strokeDasharray={`${4 / transform.k} ${3 / transform.k}`}
                pointerEvents="none"
              />
            );
          })()}
          {/* Tier 3 #25 — node-edit snap-to-vertex hover ring. When the
              user holds Alt over a vertex on the selected run while the
              node tool is active, draw a teal ring on that vertex so the
              "your alt-click will reuse this vertex" cue is unmistakable.
              Rendered before the NodeHandle layer so the white-filled
              vertex handle paints on top of the ring. Color (#1aa37a) and
              stroke width chosen to differ from both the white-fill +
              blue-stroke node handle and the pink selection halo.
              Tier 3 #61 — the same ring doubles as the break-open /
              move-opening hover affordance when that tool is active. */}
          {(tool === 'node' || tool === 'break-open') && hoveredVertex && (() => {
            const run = doc.runs.find((r) => r.id === hoveredVertex.runId);
            if (!run) return null;
            const p = run.polyline.points[hoveredVertex.pointIndex];
            if (!p) return null;
            const r = 8 / transform.k;
            return (
              <circle
                cx={p[0]}
                cy={p[1]}
                r={r}
                fill="none"
                stroke="#1aa37a"
                strokeWidth={6 / transform.k}
                strokeOpacity={0.75}
                pointerEvents="none"
              />
            );
          })()}
          {tool === 'node' &&
            (() => {
              // Default mode: only show handles for the currently selected
              // run (matches existing behavior).
              // Join-arming mode: show endpoint handles for every open run
              // so the user can pick the second endpoint without first
              // having to select the second run. Closed runs have no
              // endpoints to join, so they're skipped.
              const handles: React.ReactNode[] = [];
              const armed = joinArm;
              if (armed) {
                for (const run of doc.runs) {
                  // Tier 3 #33c — don't render endpoint join handles
                  // for hidden / locked runs; the lock blocks join
                  // selection on canvas, and there's nothing to aim
                  // at on a hidden run.
                  if (!isRunVisible(run)) continue;
                  if (isRunLocked(run)) continue;
                  if (run.polyline.closed && run.id !== armed.runId) continue;
                  const n = run.polyline.points.length;
                  if (n < 2) continue;
                  // For the armed run itself, allow self-join (head + tail
                  // → closed loop) by exposing both endpoints. For other
                  // runs, also expose both endpoints.
                  for (const ep of ['head', 'tail'] as const) {
                    if (armed.runId === run.id && armed.endpoint === ep) continue;
                    const pi = ep === 'head' ? 0 : n - 1;
                    const p = run.polyline.points[pi];
                    handles.push(
                      <NodeHandle
                        key={`node-arm-${run.id}-${ep}`}
                        x={p[0]}
                        y={p[1]}
                        k={transform.k}
                        onMove={(nx, ny) => onMoveVertex(run.id, pi, nx, ny)}
                        onShiftClick={() => onDeleteVertex(run.id, pi)}
                        onAltClick={() => onSplitRun(run.id, pi)}
                        onPlainClick={() => onPickJoinEndpoint(run.id, ep)}
                        clientToWorld={clientToWorldSnapped}
                        highlight="endpoint"
                      />,
                    );
                  }
                }
                // Highlight the armed endpoint distinctly.
                const armedRun = doc.runs.find((r) => r.id === armed.runId);
                if (armedRun) {
                  const n = armedRun.polyline.points.length;
                  const pi = armed.endpoint === 'head' ? 0 : n - 1;
                  const p = armedRun.polyline.points[pi];
                  if (p) {
                    handles.push(
                      <NodeHandle
                        key={`node-armed-${armed.runId}-${armed.endpoint}`}
                        x={p[0]}
                        y={p[1]}
                        k={transform.k}
                        onMove={(nx, ny) => onMoveVertex(armed.runId, pi, nx, ny)}
                        onShiftClick={() => onDeleteVertex(armed.runId, pi)}
                        onAltClick={() => onSplitRun(armed.runId, pi)}
                        clientToWorld={clientToWorldSnapped}
                        highlight="armed"
                      />,
                    );
                  }
                }
              }
              if (primarySelectedRunId) {
                const run = doc.runs.find((r) => r.id === primarySelectedRunId);
                if (run) {
                  const sel =
                    selectedVertices && selectedVertices.runId === run.id
                      ? selectedVertices.indices
                      : null;
                  for (let pi = 0; pi < run.polyline.points.length; pi++) {
                    const p = run.polyline.points[pi];
                    // Skip if this vertex already rendered as armed/endpoint.
                    if (armed) {
                      const isHead = pi === 0;
                      const isTail = pi === run.polyline.points.length - 1;
                      if (
                        (isHead || isTail) &&
                        !run.polyline.closed
                      ) continue;
                    }
                    const isSel = sel ? sel.has(pi) : false;
                    handles.push(
                      <NodeHandle
                        key={`node-${run.id}-${pi}`}
                        x={p[0]}
                        y={p[1]}
                        k={transform.k}
                        onMove={(nx, ny) => dispatchVertexMove(run.id, pi, nx, ny)}
                        onShiftClick={() => onDeleteVertex(run.id, pi)}
                        onAltClick={() => onSplitRun(run.id, pi)}
                        onMetaClick={() => toggleSelectedVertex(run.id, pi)}
                        onDragEnd={(fx, fy) => handleVertexDragEnd(run.id, pi, fx, fy)}
                        clientToWorld={clientToWorldSnapped}
                        selected={isSel}
                      />,
                    );
                  }
                }
              }
              return handles;
            })()}
          {doc.runs.flatMap((run) => {
            const arcs = runArcs(run);
            return (run.annotations ?? []).map((a, ai) => {
              const polyIdx = arcs.live[a.live_index];
              const p = polyIdx != null ? run.polyline.points[polyIdx] : null;
              if (!p) return null;
              return (
                <AnnotationMarker
                  key={`${run.id}-ann-${ai}`}
                  kind={a.kind}
                  x={p[0]}
                  y={p[1]}
                  sizeMM={markerSizeMM}
                  onClick={(ev) => onAnnotationClick(ev, run.id, ai)}
                />
              );
            });
          })}
          {/* Tier 3 #28 — validation marker overlay. Rendered last so it
              paints on top of runs/annotations/labels but underneath the
              SVG group's pointer-event delegation order; markers are
              individually interactive (hover tooltip + click-to-select)
              and the surrounding fill is semi-transparent so the run
              path beneath remains visible. */}
          {visibleIssues.map(({ issue, x, y, idx }) => (
            <ValidationIssueMarker
              // Stable key tied to issue identity so React doesn't
              // unmount/remount markers on every revalidation cycle —
              // the pulse animation would restart every tick otherwise.
              key={`vissue-${issue.rule}-${issue.x_mm}-${issue.y_mm}-${idx}`}
              x={x}
              y={y}
              r={issueMarkerR}
              k={transform.k}
              issue={issue}
              highlighted={hoveredIssueIndex === idx}
              onClick={() => {
                const id = nearestRunId([x, y]);
                if (id) onSelectRun(id);
                if (onIssueHover) onIssueHover(idx);
              }}
              onHoverEnter={() => onIssueHover?.(idx)}
              onHoverLeave={() => onIssueHover?.(null)}
            />
          ))}
        </g>
      </svg>
      <div className="canvas-toolbar">
        <button type="button" onClick={fitToView}>Fit</button>
        <span className="meta">
          zoom {transform.k.toFixed(2)}× · {doc.runs.length} runs · {Math.round(doc.view_box_mm[2])} × {Math.round(doc.view_box_mm[3])}mm
        </span>
        {tool === 'electrode' && (
          <span className="meta hint">Click on a path to place an electrode</span>
        )}
        {tool === 'blockout' && (
          <span className="meta hint">
            {staged ? 'Click again on the same run to set the end' : 'Click on a path to set the blockout start'}
          </span>
        )}
        {tool === 'jump' && (
          <span className="meta hint">Click on a path to mark a jump-over</span>
        )}
        {tool === 'support' && (
          <span className="meta hint">Click on a path to mark a support point</span>
        )}
        {tool === 'doubleback' && (
          <span className="meta hint">Click the apex of a hairpin to mark it as an intentional double-back</span>
        )}
        {tool === 'insert-doubleback' && (
          <span className="meta hint">
            Click a polyline segment to splice in a hairpin (1.5× ø deep). Shift-click to flip the U to the other side.
          </span>
        )}
        {tool === 'bend' && (
          <span className="meta hint">Click on a path to add a manual bend (overrides auto-detect for that run)</span>
        )}
        {tool === 'label' && (
          <span className="meta hint">Click on the canvas to drop a text label</span>
        )}
        {tool === 'dimension' && (
          <span className="meta hint">
            {stagedDim ? 'Click the second endpoint to draw the dimension' : 'Click the first endpoint of the dimension'}
          </span>
        )}
        {tool === 'node' && (
          <span className="meta hint">
            {joinArm
              ? `Join armed at ${joinArm.runId} ${joinArm.endpoint} — click another endpoint (green) to merge · alt-click within snap range commits the nearest endpoint`
              : primarySelectedRunId
                ? (selectedVertices && selectedVertices.runId === primarySelectedRunId && selectedVertices.indices.size >= 2
                    ? `${selectedVertices.indices.size} vertices selected · drag any one to translate the group · drop a vertex onto another to merge · cmd/ctrl-click to toggle · esc to clear`
                    : 'Drag to reshape · drop on another vertex to merge · cmd/ctrl-click vertex to multi-select · cmd/ctrl-drag to rubber-band · alt-click path to insert · alt-click vertex to split · shift-click vertex to delete')
                : 'Select a run first, then drag/insert/split its vertices'}
          </span>
        )}
        {tool === 'pen' && (
          <span className="meta hint">
            {drawing.tool === 'pen' && drawing.vertices.length > 0
              ? `${drawing.vertices.length} vertex${drawing.vertices.length === 1 ? '' : 'es'} · click to add · hold Shift for 15° angle snap · double-click or Enter to commit · Esc to cancel`
              : 'Click to drop the first vertex'}
          </span>
        )}
        {tool === 'rect' && (
          <span className="meta hint">Drag from one corner to the opposite corner · hold Shift for a square</span>
        )}
        {tool === 'circle' && (
          <span className="meta hint">Drag from the center out to the radius · hold Shift to lock the radius to a 15° axis</span>
        )}
        {tool === 'arc' && (
          <span className="meta hint">
            {drawing.tool === 'arc' && drawing.firstClick === null
              ? 'Click the start of the arc'
              : drawing.tool === 'arc' && drawing.secondClick === null
                ? 'Click a point on the arc · hold Shift for 15° angle snap'
                : 'Click the end of the arc · hold Shift for 15° angle snap · Esc to cancel'}
          </span>
        )}
        {tool === 'connect' && (
          <span className="meta hint">
            {connectStaged
              ? 'Click an electrode on a different run to commit the jumper · Esc / right-click to cancel'
              : 'Click an electrode pin on the source run, then on a different run to commit a jumper'}
          </span>
        )}
      </div>
    </div>
  );
}

function ElectrodeMarker({
  x,
  y,
  sizeMM,
  onClick,
  onContextMenu,
  onPointerEnter,
  onPointerLeave,
  showGear,
}: {
  x: number;
  y: number;
  sizeMM: number;
  // Tier 3 #33c — onClick is optional so locked-group electrodes can
  // render the marker (a visual reference for the operator) without
  // accepting canvas-driven clicks. The Layers sidebar stays the
  // explicit selection entry-point in that case.
  onClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  showGear?: boolean;
}) {
  const r = sizeMM / 2;
  const points = `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`;
  const interactive = !!onClick;
  // The gear icon sits to the upper-right of the marker so it doesn't
  // overlap the diamond (or its hit-area). Sized at ~70% of the marker
  // so it reads as a "secondary affordance" rather than competing for
  // attention. Pointer events ride through so the right-click on the
  // gear surfaces the same context menu as the marker.
  const gearOffset = r * 1.2;
  const gearSize = sizeMM * 0.7;
  return (
    <g>
      <polygon
        points={points}
        fill="#ff3b6b"
        stroke="#fff"
        strokeWidth={r * 0.15}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        // Locked-group electrode markers don't pick up clicks. Setting
        // pointer-events: none here is enough — the Layers sidebar is
        // the deliberate escape hatch for selecting locked-group runs.
        pointerEvents={interactive ? undefined : 'none'}
        style={{ cursor: interactive ? 'pointer' : 'default' }}
      >
        <title>
          {onContextMenu
            ? 'Click to select; shift/alt-click to delete; right-click for housing'
            : 'Click to select; shift/alt-click to delete'}
        </title>
      </polygon>
      {showGear && (
        <g
          transform={`translate(${x + gearOffset}, ${y - gearOffset})`}
          pointerEvents="none"
        >
          <circle r={gearSize / 2} fill="#fff" stroke="#666" strokeWidth={r * 0.1} />
          <text
            x={0}
            y={gearSize / 4}
            textAnchor="middle"
            fontSize={gearSize * 0.85}
            fill="#444"
            style={{ userSelect: 'none' }}
          >
            ⚙
          </text>
        </g>
      )}
    </g>
  );
}

function NodeHandle({
  x,
  y,
  k,
  onMove,
  onShiftClick,
  onAltClick,
  onMetaClick,
  onPlainClick,
  onDragEnd,
  clientToWorld,
  highlight,
  selected,
}: {
  x: number;
  y: number;
  k: number;
  onMove: (x: number, y: number) => void;
  onShiftClick: () => void;
  onAltClick?: () => void;
  // Tier 3 #48 — Cmd/Ctrl-click toggles this vertex in/out of the
  // multi-vertex selection. Falls through to onPlainClick if not wired.
  onMetaClick?: () => void;
  onPlainClick?: () => void;
  // Tier 3 #48 — fires on pointerup AFTER a drag (moved===true) with
  // the final world-space XY. The canvas uses this to detect a
  // vertex-merge drop (released within snap-to-vertex range of another
  // vertex on the same run).
  onDragEnd?: (x: number, y: number) => void;
  clientToWorld: (cx: number, cy: number) => [number, number] | null;
  highlight?: 'endpoint' | 'armed' | null;
  // Tier 3 #48 — render this handle with the multi-select badge fill so
  // the operator can see at a glance which vertices are part of the
  // group drag. Visually distinct from the alt-hover ring (rendered
  // separately) and from the endpoint/armed fills (which take priority).
  selected?: boolean;
}) {
  const dragging = useRef(false);
  const moved = useRef(false);
  const lastXY = useRef<[number, number] | null>(null);
  const handlePointerDown = (e: React.PointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    if (e.shiftKey) {
      onShiftClick();
      return;
    }
    if (e.altKey) {
      if (onAltClick) onAltClick();
      else onShiftClick();
      return;
    }
    dragging.current = true;
    moved.current = false;
    lastXY.current = null;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    moved.current = true;
    const w = clientToWorld(e.clientX, e.clientY);
    if (w) {
      lastXY.current = w;
      onMove(w[0], w[1]);
    }
  };
  const handlePointerUp = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.stopPropagation();
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      // pointer might already be released
    }
    if (!moved.current) {
      // Plain click without a drag: cmd/ctrl wins (multi-vertex toggle);
      // otherwise fall through to onPlainClick (join-arm endpoint pick).
      if ((e.metaKey || e.ctrlKey) && onMetaClick) {
        onMetaClick();
      } else if (onPlainClick) {
        onPlainClick();
      }
    } else if (onDragEnd && lastXY.current) {
      onDragEnd(lastXY.current[0], lastXY.current[1]);
    }
    moved.current = false;
    lastXY.current = null;
  };
  const fill =
    highlight === 'armed' ? '#ff8a00'
    : highlight === 'endpoint' ? '#1aa37a'
    : selected ? '#ffd24c'
    : '#fff';
  const stroke =
    highlight === 'armed' ? '#ff8a00'
    : highlight === 'endpoint' ? '#1aa37a'
    : selected ? '#c98700'
    : '#1f6feb';
  const r = (highlight || selected ? 4 : 3) / k;
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      fill={fill}
      stroke={stroke}
      strokeWidth={1 / k}
      style={{ cursor: 'grab' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}

function LabelMarker({
  x,
  y,
  text,
  k,
  onClick,
}: {
  x: number;
  y: number;
  text: string;
  k: number;
  onClick: (e: React.MouseEvent) => void;
}) {
  // Render at a fixed pixel-equivalent size regardless of zoom.
  const fontSize = 14 / k;
  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }}>
      <circle cx={x} cy={y} r={3 / k} fill="#1f6feb" />
      <text
        x={x + 6 / k}
        y={y - 4 / k}
        fontSize={fontSize}
        fontFamily="-apple-system, system-ui, sans-serif"
        fill="#1f6feb"
        stroke="#fff"
        strokeWidth={3 / k}
        paintOrder="stroke fill"
      >
        {text || '(label)'}
      </text>
    </g>
  );
}

function DimensionMarker({
  x1,
  y1,
  x2,
  y2,
  note,
  k,
  onClick,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  note?: string;
  k: number;
  onClick: (e: React.MouseEvent) => void;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  // Tick perpendicular to the line, fixed pixel size.
  const tick = 5 / k;
  const angle = Math.atan2(dy, dx);
  const px = -Math.sin(angle) * tick;
  const py = Math.cos(angle) * tick;
  const fontSize = 12 / k;
  const label = note ? `${length.toFixed(1)}mm · ${note}` : `${length.toFixed(1)}mm`;
  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#1f6feb" strokeWidth={1 / k} />
      <line x1={x1 - px} y1={y1 - py} x2={x1 + px} y2={y1 + py} stroke="#1f6feb" strokeWidth={1 / k} />
      <line x1={x2 - px} y1={y2 - py} x2={x2 + px} y2={y2 + py} stroke="#1f6feb" strokeWidth={1 / k} />
      <text
        x={midX + px}
        y={midY + py - 1 / k}
        fontSize={fontSize}
        fontFamily="-apple-system, system-ui, sans-serif"
        fill="#1f6feb"
        stroke="#fff"
        strokeWidth={3 / k}
        paintOrder="stroke fill"
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
}

function BendMarker({
  x,
  y,
  sizeMM,
  manual,
}: {
  x: number;
  y: number;
  sizeMM: number;
  manual: boolean;
}) {
  // Hollow disc; filled when the user has overridden the auto-detected list,
  // so they can tell at a glance which mode the run is in. Non-interactive —
  // the sidebar list is where you remove or jump to bends.
  const r = sizeMM / 2;
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      fill={manual ? '#ff8a00' : '#fff'}
      stroke="#ff8a00"
      strokeWidth={r * 0.35}
      pointerEvents="none"
    />
  );
}

function AnnotationMarker({
  kind,
  x,
  y,
  sizeMM,
  onClick,
}: {
  kind: AnnotationKind;
  x: number;
  y: number;
  sizeMM: number;
  onClick: (e: React.MouseEvent) => void;
}) {
  const r = sizeMM / 2;
  if (kind === 'jump') {
    // Half-circle arch above the tube — represents the tube lifting up
    // and over an obstacle.
    const d = `M${x - r},${y} A${r},${r} 0 0 1 ${x + r},${y}`;
    return (
      <g onClick={onClick} style={{ cursor: 'pointer' }}>
        <circle cx={x} cy={y} r={r} fill="#fff" stroke="#0096ff" strokeWidth={r * 0.15} />
        <path d={d} fill="none" stroke="#0096ff" strokeWidth={r * 0.3} strokeLinecap="round" />
      </g>
    );
  }
  if (kind === 'doubleback') {
    // Tight U-arrow — visualizes the intent: the tube doubles back on
    // itself here and the bend-radius rule should treat it as legitimate.
    const u = r * 0.55;
    const d = `M${x - u},${y + u} L${x - u},${y - u * 0.4} A${u},${u} 0 0 1 ${x + u},${y - u * 0.4} L${x + u},${y + u}`;
    return (
      <g onClick={onClick} style={{ cursor: 'pointer' }}>
        <circle cx={x} cy={y} r={r} fill="#fff" stroke="#1aa37a" strokeWidth={r * 0.15} />
        <path d={d} fill="none" stroke="#1aa37a" strokeWidth={r * 0.25} strokeLinecap="round" />
      </g>
    );
  }
  // Support: anchor-style triangle pointing down.
  const points = `${x - r * 0.8},${y - r} ${x + r * 0.8},${y - r} ${x},${y + r * 0.7}`;
  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }}>
      <circle cx={x} cy={y} r={r} fill="#fff" stroke="#7a4cff" strokeWidth={r * 0.15} />
      <polygon points={points} fill="#7a4cff" />
    </g>
  );
}

// Tier 3 #28 — single validator-issue marker. Severity-colored, semi-
// transparent fill so the run beneath stays legible, and a child `<title>`
// for an accessible native browser tooltip carrying `rule: message`. The
// circle is the only interactive element; the surrounding `<g>` keeps the
// tooltip + click target unified without the extra DOM noise of a wrapper.
//
// Tier 3 #47 — `highlighted` adds a CSS class that triggers the pulse
// keyframes (App.css), and the hover handlers bubble up to the parent
// via `onHoverEnter` / `onHoverLeave` so the sidebar row can highlight
// in lock-step. The pulse runs on stroke-width + stroke-opacity rather
// than radius so the marker centroid stays anchored on the issue's
// world-space coordinate (radius animation would visually drift).
function ValidationIssueMarker({
  x,
  y,
  r,
  k,
  issue,
  highlighted,
  onClick,
  onHoverEnter,
  onHoverLeave,
}: {
  x: number;
  y: number;
  r: number;
  k: number;
  issue: ValidationIssue;
  highlighted: boolean;
  onClick: () => void;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
}) {
  const isError = issue.severity === 'error';
  const stroke = isError ? 'var(--error)' : 'var(--warn)';
  const fill = isError ? 'rgba(255, 107, 107, 0.45)' : 'rgba(255, 170, 0, 0.45)';
  const className = highlighted
    ? 'validation-marker validation-marker-pulse'
    : 'validation-marker';
  return (
    <circle
      cx={x}
      cy={y}
      r={r}
      fill={fill}
      stroke={stroke}
      strokeWidth={1 / k}
      className={className}
      style={{ cursor: 'pointer' }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
    >
      <title>{`${issue.rule}: ${issue.message}`}</title>
    </circle>
  );
}

// Tier 3 #25 — snap-to-vertex radius (mm) used by the node-edit alt-
// hover. The MAX of "8 device pixels at the current zoom" and "half
// the user's snap-grid setting" — the first keeps the target visually
// generous regardless of zoom, the second ties grabbing radius to the
// drawing precision the user has already chosen. When snap is
// disabled or zero, only the pixel-based floor matters.
function nodeSnapRadiusMM(k: number, snapEnabled: boolean, snapMM: number): number {
  const pixelMM = 8 / k;
  if (snapEnabled && snapMM > 0) return Math.max(pixelMM, snapMM / 2);
  return pixelMM;
}

// Tier 3 #25 — find the index of the polyline vertex closest to
// `target` within `radius` mm. Returns null when no vertex is within
// range. Squared-distance compare avoids the sqrt; the cost is one
// extra multiply on `radius`.
function nearestVertexWithin(
  points: [number, number][],
  target: [number, number],
  radius: number,
): number | null {
  const r2 = radius * radius;
  let best: number | null = null;
  let bestD = r2;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i][0] - target[0];
    const dy = points[i][1] - target[1];
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function nearestPointIndex(points: [number, number][], target: [number, number]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dx = points[i][0] - target[0];
    const dy = points[i][1] - target[1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Given a polyline and a target world-space point, find which segment is
// closest and where on that segment the foot of the perpendicular falls
// (parametric t ∈ [0,1]). Used by the Insert-DB tool to map a click into
// the (segmentIndex, t) coordinates the docOps helper expects.
function nearestSegmentT(
  points: [number, number][],
  target: [number, number],
): { segmentIndex: number; t: number } {
  let bestSeg = 0;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i][0];
    const ay = points[i][1];
    const bx = points[i + 1][0];
    const by = points[i + 1][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const tRaw = ((target[0] - ax) * dx + (target[1] - ay) * dy) / len2;
    const tClamped = Math.max(0, Math.min(1, tRaw));
    const px = ax + tClamped * dx;
    const py = ay + tClamped * dy;
    const ddx = target[0] - px;
    const ddy = target[1] - py;
    const d = ddx * ddx + ddy * ddy;
    if (d < bestD) {
      bestD = d;
      bestSeg = i;
      bestT = tClamped;
    }
  }
  return { segmentIndex: bestSeg, t: bestT };
}

// Compute the four hairpin vertices for the canvas ghost preview. Mirrors
// the arithmetic in docOps.insertDoubleback so the preview matches what
// will actually get spliced in — keep these in sync.
function doublebackPreviewVertices(
  p1: [number, number],
  p2: [number, number],
  t: number,
  depthMM: number,
  gapMM: number,
  side: 'left' | 'right',
): [number, number][] | null {
  const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (!(segLen > 0)) return null;
  const fx = (p2[0] - p1[0]) / segLen;
  const fy = (p2[1] - p1[1]) / segLen;
  const sx = side === 'left' ? -fy : fy;
  const sy = side === 'left' ? fx : -fx;
  const pix = p1[0] + t * (p2[0] - p1[0]);
  const piy = p1[1] + t * (p2[1] - p1[1]);
  const ax = pix - 0.5 * gapMM * fx;
  const ay = piy - 0.5 * gapMM * fy;
  const bx = ax + depthMM * sx;
  const by = ay + depthMM * sy;
  const cx = bx + gapMM * fx;
  const cy = by + gapMM * fy;
  const dx = cx - depthMM * sx;
  const dy = cy - depthMM * sy;
  return [
    [ax, ay],
    [bx, by],
    [cx, cy],
    [dx, dy],
  ];
}
