import { useEffect, useRef, useState } from 'react';
import type { DesignDoc, DesignRun } from '../api';
import { runArcs, indicesToD, nearestLiveArcIndex, blockoutSegments } from '../lib/runArcs';
import { colorHex } from '../lib/neonColors';
import { effectiveBends } from '../lib/bends';

type Transform = { tx: number; ty: number; k: number };

export type EditorTool =
  | 'select'
  | 'electrode'
  | 'blockout'
  | 'jump'
  | 'support'
  | 'doubleback'
  | 'bend'
  | 'label'
  | 'dimension'
  | 'node';

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
}: {
  doc: DesignDoc;
  tool: EditorTool;
  selectedRunId: string | null;
  projectDiameterMM: number;
  snapEnabled: boolean;
  snapMM: number;
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
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ tx: 0, ty: 0, k: 1 });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });
  const [staged, setStaged] = useState<StagedBlockout | null>(null);
  const [stagedDim, setStagedDim] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number; moved: boolean } | null>(null);

  // Drop the staged blockout when leaving blockout mode so a stale start
  // doesn't surprise the user when they come back later.
  useEffect(() => {
    if (tool !== 'blockout') setStaged(null);
    if (tool !== 'dimension') setStagedDim(null);
  }, [tool]);

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

  // Fit on first measurement of the design doc.
  const fittedDocRef = useRef<DesignDoc | null>(null);
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    if (fittedDocRef.current === doc) return;
    const [x, y, w, h] = doc.view_box_mm;
    if (w <= 0 || h <= 0) return;
    const padding = 0.9;
    const scale = Math.min(size.w / w, size.h / h) * padding;
    setTransform({
      k: scale,
      tx: size.w / 2 - (x + w / 2) * scale,
      ty: size.h / 2 - (y + h / 2) * scale,
    });
    fittedDocRef.current = doc;
  }, [doc, size.w, size.h]);

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
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      dragRef.current.moved = true;
      setTransform((t) => ({ ...t, tx: dragRef.current!.tx + dx, ty: dragRef.current!.ty + dy }));
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
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
    if (isBackground) {
      onSelectRun(null);
    }
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
    onSelectRun(run.id);
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
          {tool === 'node' && selectedRunId &&
            (() => {
              const run = doc.runs.find((r) => r.id === selectedRunId);
              if (!run) return null;
              return run.polyline.points.map((p, pi) => (
                <NodeHandle
                  key={`node-${selectedRunId}-${pi}`}
                  x={p[0]}
                  y={p[1]}
                  k={transform.k}
                  onMove={(nx, ny) => onMoveVertex(run.id, pi, nx, ny)}
                  onShiftClick={() => onDeleteVertex(run.id, pi)}
                  clientToWorld={clientToWorldSnapped}
                />
              ));
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
            {selectedRunId
              ? 'Drag a vertex to reshape · shift-click a vertex to delete'
              : 'Select a run first, then drag its vertices'}
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
  clientToWorld,
}: {
  x: number;
  y: number;
  k: number;
  onMove: (x: number, y: number) => void;
  onShiftClick: () => void;
  clientToWorld: (cx: number, cy: number) => [number, number] | null;
}) {
  const dragging = useRef(false);
  const handlePointerDown = (e: React.PointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    if (e.shiftKey || e.altKey) {
      onShiftClick();
      return;
    }
    dragging.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const handlePointerMove = (e: React.PointerEvent<SVGCircleElement>) => {
    if (!dragging.current) return;
    e.stopPropagation();
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
  };
  return (
    <circle
      cx={x}
      cy={y}
      r={3 / k}
      fill="#fff"
      stroke="#1f6feb"
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
