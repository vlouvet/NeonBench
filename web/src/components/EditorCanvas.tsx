import { useEffect, useRef, useState } from 'react';
import type { DesignDoc, DesignRun } from '../api';
import { runArcs, indicesToD } from '../lib/runArcs';

type Transform = { tx: number; ty: number; k: number };

export type EditorTool = 'select' | 'electrode';

const MIN_SCALE = 0.05;
const MAX_SCALE = 200;

export default function EditorCanvas({
  doc,
  tool,
  selectedRunId,
  onSelectRun,
  onPlaceElectrode,
  onDeleteElectrode,
}: {
  doc: DesignDoc;
  tool: EditorTool;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onPlaceElectrode: (runId: string, pointIndex: number) => void;
  onDeleteElectrode: (runId: string, electrodeIndex: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ tx: 0, ty: 0, k: 1 });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });
  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number; moved: boolean } | null>(null);

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
    // Click on background → deselect (if not on a path or marker)
    const tag = (e.target as SVGElement).tagName;
    if (tag === 'svg' || tag === 'rect') {
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
    onSelectRun(run.id);
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
            const liveD = indicesToD(arcs.live, run.polyline.points, arcs.liveClosed);
            const inactiveD = arcs.inactive.length > 1
              ? indicesToD(arcs.inactive, run.polyline.points, false)
              : '';
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
                <path
                  d={liveD}
                  stroke={selected ? '#ff3b6b' : '#222'}
                  strokeWidth={(selected ? 1.6 : 0.8) / transform.k}
                  fill="none"
                  onClick={(e) => onRunClick(e, run)}
                  style={{ cursor: tool === 'electrode' ? 'crosshair' : 'pointer' }}
                />
              </g>
            );
          })}
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
