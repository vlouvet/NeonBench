import { useEffect, useMemo, useRef, useState } from 'react';
import type { DesignDoc, DesignRun, ValidationIssue } from '../api';
import { runArcs, indicesToD, nearestLiveArcIndex, blockoutSegments } from '../lib/runArcs';
import { colorHex } from '../lib/neonColors';
import { effectiveBends } from '../lib/bends';
import { rectToPoints } from '../lib/shapes/rect';
import { circleToPoints } from '../lib/shapes/circle';
import { threePointArcToPoints } from '../lib/shapes/arc';

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
  | 'arc';

export type AnnotationKind = 'jump' | 'support' | 'doubleback';

type StagedBlockout = { runId: string; liveIndex: number };

const MIN_SCALE = 0.05;
const MAX_SCALE = 200;

export default function EditorCanvas({
  doc,
  tool,
  selectedRunId,
  projectDiameterMM,
  snapEnabled,
  snapMM,
  onSelectRun,
  onPlaceElectrode,
  onDeleteElectrode,
  onPlaceBlockout,
  onPlaceAnnotation,
  onDeleteAnnotation,
  onPlaceBend,
  onPlaceLabel,
  onPlaceDimension,
  onDeleteLabel,
  onDeleteDimension,
  onMoveVertex,
  onDeleteVertex,
  onInsertVertex,
  onSplitRun,
  joinArm,
  onPickJoinEndpoint,
  onInsertDoubleback,
  onCommitShape,
  validationIssues,
  issueSeverityFilter,
  hoveredIssueIndex,
  onIssueHover,
  centerOnIssue,
}: {
  doc: DesignDoc;
  tool: EditorTool;
  selectedRunId: string | null;
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
  onSelectRun: (id: string | null) => void;
  onPlaceElectrode: (runId: string, pointIndex: number) => void;
  onDeleteElectrode: (runId: string, electrodeIndex: number) => void;
  onPlaceBlockout: (runId: string, startLiveIndex: number, endLiveIndex: number) => void;
  onPlaceAnnotation: (runId: string, kind: AnnotationKind, liveIndex: number) => void;
  onDeleteAnnotation: (runId: string, annotationIndex: number) => void;
  onPlaceBend: (runId: string, liveIndex: number) => void;
  onPlaceLabel: (x: number, y: number) => void;
  onPlaceDimension: (x1: number, y1: number, x2: number, y2: number) => void;
  onDeleteLabel: (index: number) => void;
  onDeleteDimension: (index: number) => void;
  onMoveVertex: (runId: string, pointIndex: number, x: number, y: number) => void;
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
  // Commit a freshly drawn shape as a new run. EditorPage owns the
  // appendRuns / id-prefix logic; the canvas just hands up the geometry
  // and the kind so the parent can pick the right id prefix and decide on
  // direction/electrodes (for V1: none).
  onCommitShape: (kind: 'pen' | 'rect' | 'circle' | 'arc', points: [number, number][], closed: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ tx: 0, ty: 0, k: 1 });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });
  const [staged, setStaged] = useState<StagedBlockout | null>(null);
  const [stagedDim, setStagedDim] = useState<{ x: number; y: number } | null>(null);
  // Pen tool: accumulated vertices of the in-progress polyline plus a
  // hover-tracked cursor point so the preview "rubber-bands" from the last
  // dropped vertex out to wherever the mouse is right now.
  const [penPoints, setPenPoints] = useState<[number, number][]>([]);
  const [penHover, setPenHover] = useState<[number, number] | null>(null);
  // Rect / circle tool: pointer-down origin + current drag point. While
  // dragging both are set; when the drag commits we clear back to null.
  const [shapeDrag, setShapeDrag] = useState<{
    kind: 'rect' | 'circle';
    a: [number, number];
    b: [number, number];
  } | null>(null);
  const shapeDragRef = useRef<{ pointerId: number } | null>(null);
  // Arc tool: 3-point sequential clicks. Stored as 0/1/2 collected vertices.
  // While at 1 or 2 vertices, the canvas hover updates the preview shape.
  const [arcPoints, setArcPoints] = useState<[number, number][]>([]);
  const [arcHover, setArcHover] = useState<[number, number] | null>(null);
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
  // tool change (see the prevTool reset block below) and on Alt
  // release / pointer leave.
  const [hoveredVertex, setHoveredVertex] = useState<{
    runId: string;
    pointIndex: number;
  } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number; moved: boolean } | null>(null);

  // Drop staged state when leaving the corresponding tool so a previously
  // dropped vertex doesn't surprise the user when they come back later.
  // Implemented with the "previous prop" pattern from the React docs
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // so the resets happen during render rather than in an effect — this
  // avoids the cascading-render hit from useEffect-based prop sync and
  // keeps react-hooks/set-state-in-effect happy.
  const [prevTool, setPrevTool] = useState(tool);
  if (prevTool !== tool) {
    setPrevTool(tool);
    if (tool !== 'blockout' && staged !== null) setStaged(null);
    if (tool !== 'dimension' && stagedDim !== null) setStagedDim(null);
    if (tool !== 'pen') {
      if (penPoints.length > 0) setPenPoints([]);
      if (penHover !== null) setPenHover(null);
    }
    if (tool !== 'rect' && tool !== 'circle') {
      if (shapeDrag !== null) setShapeDrag(null);
      // shapeDragRef is mutated in pointerDown/pointerUp event handlers;
      // clearing it during render trips the react-hooks/refs rule and
      // (since the ref is only ever written, never read) doesn't change
      // observable behavior. The pointer event handlers handle their
      // own lifecycle.
    }
    if (tool !== 'arc') {
      if (arcPoints.length > 0) setArcPoints([]);
      if (arcHover !== null) setArcHover(null);
    }
    if (tool !== 'insert-doubleback' && dbHover !== null) setDbHover(null);
    if (tool !== 'node' && hoveredVertex !== null) setHoveredVertex(null);
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
        if (tool === 'pen' && penPoints.length > 0) {
          e.preventDefault();
          setPenPoints([]);
          setPenHover(null);
          return;
        }
        if (tool === 'arc' && arcPoints.length > 0) {
          e.preventDefault();
          setArcPoints([]);
          setArcHover(null);
          return;
        }
        if ((tool === 'rect' || tool === 'circle') && shapeDrag) {
          e.preventDefault();
          setShapeDrag(null);
          return;
        }
      }
      if (e.key === 'Enter') {
        if (tool === 'pen' && penPoints.length >= 2) {
          e.preventDefault();
          onCommitShape('pen', penPoints.slice(), false);
          setPenPoints([]);
          setPenHover(null);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, penPoints, arcPoints, shapeDrag, onCommitShape]);

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
    // Rect / circle: pointer-down captures origin and starts the drag
    // preview. We capture the pointer so a fast drag that exits the SVG
    // before pointer-up still resolves cleanly.
    if (tool === 'rect' || tool === 'circle') {
      const world = clientToWorldSnapped(e.clientX, e.clientY);
      if (!world) return;
      setShapeDrag({ kind: tool, a: world, b: world });
      shapeDragRef.current = { pointerId: e.pointerId };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
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
    if (tool === 'pen' && penPoints.length > 0) {
      const w = clientToWorldSnapped(e.clientX, e.clientY);
      if (w) setPenHover(w);
    }
    if (tool === 'arc' && arcPoints.length > 0 && arcPoints.length < 3) {
      const w = clientToWorldSnapped(e.clientX, e.clientY);
      if (w) setArcHover(w);
    }
    // Tier 3 #25 — node-edit alt-hover. When the user holds Alt over the
    // selected run while the node tool is active, find the nearest
    // existing vertex and (if within the snap radius) flag it as the
    // current snap target. The visible ring renders below; the alt-click
    // handler in onRunClick consults the same state to skip a redundant
    // insert.
    if (tool === 'node') {
      if (e.altKey && selectedRunId) {
        const w = clientToWorld(e.clientX, e.clientY);
        const run = w ? doc.runs.find((r) => r.id === selectedRunId) : null;
        if (w && run) {
          const snap = nodeSnapRadiusMM(transform.k, snapEnabled, snapMM);
          const hit = nearestVertexWithin(run.polyline.points, w, snap);
          if (hit !== null) {
            const next = { runId: run.id, pointIndex: hit };
            if (!hoveredVertex || hoveredVertex.runId !== next.runId || hoveredVertex.pointIndex !== next.pointIndex) {
              setHoveredVertex(next);
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
    if (shapeDrag) {
      const w = clientToWorldSnapped(e.clientX, e.clientY);
      if (w) setShapeDrag((prev) => (prev ? { ...prev, b: w } : prev));
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
    // Rect / circle: pointer-up commits the drawn shape. We require a
    // minimum drag distance (1mm in world space) so an accidental click
    // doesn't emit a degenerate run.
    if (shapeDrag) {
      const { kind, a, b } = shapeDrag;
      try {
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
      } catch {
        // already released
      }
      shapeDragRef.current = null;
      setShapeDrag(null);
      if (kind === 'rect') {
        const w = Math.abs(a[0] - b[0]);
        const h = Math.abs(a[1] - b[1]);
        if (w >= 1 && h >= 1) {
          onCommitShape('rect', rectToPoints(a[0], a[1], b[0], b[1]), true);
        }
      } else {
        const r = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (r >= 1) {
          onCommitShape('circle', circleToPoints(a[0], a[1], r, 64), true);
        }
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
    if (tool === 'pen' && isBackground) {
      // Click drops a vertex; double-click is detected via React's
      // onDoubleClick handler on the SVG so we keep the dispatch local.
      const world = clientToWorldSnapped(e.clientX, e.clientY);
      if (!world) return;
      setPenPoints((prev) => [...prev, world]);
      setPenHover(world);
      return;
    }
    if (tool === 'arc' && isBackground) {
      const world = clientToWorldSnapped(e.clientX, e.clientY);
      if (!world) return;
      setArcPoints((prev) => {
        const next: [number, number][] = [...prev, world];
        if (next.length === 3) {
          // Commit on the third click. The arc helper handles the
          // degenerate-collinear fallback.
          const pts = threePointArcToPoints(next[0], next[1], next[2], 3);
          onCommitShape('arc', pts, false);
          setArcHover(null);
          return [];
        }
        setArcHover(world);
        return next;
      });
      return;
    }
    if (isBackground) {
      onSelectRun(null);
    }
  }

  function onDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (tool !== 'pen') return;
    const tag = (e.target as SVGElement).tagName;
    if (tag !== 'svg' && tag !== 'rect') return;
    // Double-click also fires the underlying single click first, so by the
    // time React re-renders, penPoints may have grown by one. Read the
    // latest list inside the functional updater to avoid committing a
    // stale snapshot. Commit if we have ≥2 vertices, otherwise quietly
    // cancel.
    e.preventDefault();
    setPenPoints((prev) => {
      if (prev.length >= 2) onCommitShape('pen', prev.slice(), false);
      return [];
    });
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
    if (tool === 'node') {
      // Alt-click on the polyline (not on a vertex handle) inserts a new
      // vertex at the click point. The selected run must match the
      // clicked run; otherwise just select the new run so the user can
      // see its existing vertices first.
      if (e.altKey && run.id === selectedRunId) {
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
    onSelectRun(run.id);
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
  function nearestRunId(target: [number, number]): string | null {
    let bestId: string | null = null;
    let bestD = Infinity;
    for (const run of doc.runs) {
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
      >
        <rect x={0} y={0} width={size.w} height={size.h} fill="transparent" />
        <g transform={`translate(${transform.tx},${transform.ty}) scale(${transform.k})`}>
          {doc.runs.map((run) => {
            const selected = run.id === selectedRunId;
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
                    strokeOpacity={0.35}
                    fill="none"
                    pointerEvents="none"
                  />
                )}
                {/* Hit-target stroke: invisible but pointer-events="stroke"
                    so SVG hit-tests it regardless of paint. Wide enough
                    that clicks don't have to land on the 1px visible line.
                    Layered under the visible strokes so the latter render
                    on top. */}
                <path
                  d={liveD}
                  stroke="black"
                  strokeOpacity={0}
                  strokeWidth={hitWidth}
                  fill="none"
                  pointerEvents="stroke"
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
                  return (
                    <path
                      key={`alive-${si}`}
                      d={d}
                      stroke={liveStroke}
                      strokeWidth={liveWidth}
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
          {tool === 'pen' && penPoints.length > 0 && (() => {
            const sample: [number, number][] = penHover
              ? [...penPoints, penHover]
              : penPoints;
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
                {penPoints.map((p, i) => (
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
          {tool === 'rect' && shapeDrag && shapeDrag.kind === 'rect' && (() => {
            const xMin = Math.min(shapeDrag.a[0], shapeDrag.b[0]);
            const yMin = Math.min(shapeDrag.a[1], shapeDrag.b[1]);
            const w = Math.abs(shapeDrag.a[0] - shapeDrag.b[0]);
            const h = Math.abs(shapeDrag.a[1] - shapeDrag.b[1]);
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
          {tool === 'circle' && shapeDrag && shapeDrag.kind === 'circle' && (() => {
            const r = Math.hypot(shapeDrag.a[0] - shapeDrag.b[0], shapeDrag.a[1] - shapeDrag.b[1]);
            return (
              <g pointerEvents="none">
                <circle
                  cx={shapeDrag.a[0]}
                  cy={shapeDrag.a[1]}
                  r={r}
                  stroke="#ff8a00"
                  strokeWidth={1.6 / transform.k}
                  strokeDasharray={`${3 / transform.k} ${2 / transform.k}`}
                  fill="none"
                />
                <circle
                  cx={shapeDrag.a[0]}
                  cy={shapeDrag.a[1]}
                  r={3 / transform.k}
                  fill="#ff8a00"
                />
              </g>
            );
          })()}
          {tool === 'arc' && arcPoints.length > 0 && (() => {
            // Live arc preview: with 1 point, just show a marker. With 2
            // (or 2 + hover), draw a candidate arc through the trio.
            const pts = arcHover && arcPoints.length < 3
              ? [...arcPoints, arcHover]
              : arcPoints;
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
                {arcPoints.map((p, i) => (
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
          {doc.runs.flatMap((run) =>
            (run.electrodes ?? []).map((e, ei) => {
              const p = run.polyline.points[e.point_index];
              if (!p) return null;
              return (
                <ElectrodeMarker
                  key={`${run.id}-${ei}`}
                  x={p[0]}
                  y={p[1]}
                  sizeMM={markerSizeMM}
                  onClick={(ev) => onElectrodeClick(ev, run.id, ei)}
                />
              );
            }),
          )}
          {selectedRunId &&
            (() => {
              const run = doc.runs.find((r) => r.id === selectedRunId);
              if (!run) return null;
              const bends = effectiveBends(run, projectDiameterMM);
              const isManual = !!run.bends && run.bends.length > 0;
              return bends.map((b, bi) => (
                <BendMarker
                  key={`bend-${selectedRunId}-${bi}`}
                  x={b.x}
                  y={b.y}
                  sizeMM={markerSizeMM * 0.6}
                  manual={isManual}
                />
              ));
            })()}
          {/* Tier 3 #25 — node-edit snap-to-vertex hover ring. When the
              user holds Alt over a vertex on the selected run while the
              node tool is active, draw a teal ring on that vertex so the
              "your alt-click will reuse this vertex" cue is unmistakable.
              Rendered before the NodeHandle layer so the white-filled
              vertex handle paints on top of the ring. Color (#1aa37a) and
              stroke width chosen to differ from both the white-fill +
              blue-stroke node handle and the pink selection halo. */}
          {tool === 'node' && hoveredVertex && (() => {
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
              if (selectedRunId) {
                const run = doc.runs.find((r) => r.id === selectedRunId);
                if (run) {
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
                    handles.push(
                      <NodeHandle
                        key={`node-${run.id}-${pi}`}
                        x={p[0]}
                        y={p[1]}
                        k={transform.k}
                        onMove={(nx, ny) => onMoveVertex(run.id, pi, nx, ny)}
                        onShiftClick={() => onDeleteVertex(run.id, pi)}
                        onAltClick={() => onSplitRun(run.id, pi)}
                        clientToWorld={clientToWorldSnapped}
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
              ? `Join armed at ${joinArm.runId} ${joinArm.endpoint} — click another endpoint (green) to merge`
              : selectedRunId
                ? 'Drag to reshape · alt-click path to insert vertex · alt-click vertex to split run · shift-click vertex to delete'
                : 'Select a run first, then drag/insert/split its vertices'}
          </span>
        )}
        {tool === 'pen' && (
          <span className="meta hint">
            {penPoints.length === 0
              ? 'Click to drop the first vertex'
              : `${penPoints.length} vertex${penPoints.length === 1 ? '' : 'es'} · click to add · double-click or Enter to commit · Esc to cancel`}
          </span>
        )}
        {tool === 'rect' && (
          <span className="meta hint">Drag from one corner to the opposite corner</span>
        )}
        {tool === 'circle' && (
          <span className="meta hint">Drag from the center out to the radius</span>
        )}
        {tool === 'arc' && (
          <span className="meta hint">
            {arcPoints.length === 0
              ? 'Click the start of the arc'
              : arcPoints.length === 1
                ? 'Click a point on the arc'
                : 'Click the end of the arc · Esc to cancel'}
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
}: {
  x: number;
  y: number;
  sizeMM: number;
  onClick: (e: React.MouseEvent) => void;
}) {
  const r = sizeMM / 2;
  const points = `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`;
  return (
    <polygon
      points={points}
      fill="#ff3b6b"
      stroke="#fff"
      strokeWidth={r * 0.15}
      onClick={onClick}
      style={{ cursor: 'pointer' }}
    />
  );
}

function NodeHandle({
  x,
  y,
  k,
  onMove,
  onShiftClick,
  onAltClick,
  onPlainClick,
  clientToWorld,
  highlight,
}: {
  x: number;
  y: number;
  k: number;
  onMove: (x: number, y: number) => void;
  onShiftClick: () => void;
  onAltClick?: () => void;
  onPlainClick?: () => void;
  clientToWorld: (cx: number, cy: number) => [number, number] | null;
  highlight?: 'endpoint' | 'armed' | null;
}) {
  const dragging = useRef(false);
  const moved = useRef(false);
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
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    moved.current = true;
    const w = clientToWorld(e.clientX, e.clientY);
    if (w) onMove(w[0], w[1]);
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
    // Plain click without a drag: surface as an explicit click for the
    // join-arming flow (which fires on endpoint vertices specifically).
    if (!moved.current && onPlainClick) onPlainClick();
    moved.current = false;
  };
  const fill = highlight === 'armed' ? '#ff8a00' : highlight === 'endpoint' ? '#1aa37a' : '#fff';
  const stroke = highlight === 'armed' ? '#ff8a00' : highlight === 'endpoint' ? '#1aa37a' : '#1f6feb';
  const r = (highlight ? 4 : 3) / k;
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
