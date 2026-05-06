import { useEffect, useRef, useState } from 'react';
import type { DesignDoc } from '../api';

type Transform = { tx: number; ty: number; k: number };

const MIN_SCALE = 0.05;
const MAX_SCALE = 200;

export default function EditorCanvas({
  doc,
  selectedRunId,
  onSelectRun,
}: {
  doc: DesignDoc;
  selectedRunId: string | null;
  onSelectRun: (id: string | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>({ tx: 0, ty: 0, k: 1 });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 });
  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null);

  // Watch container size so we can fit the design and convert mouse coords.
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

  // Fit the design to the viewport whenever the doc or container changes.
  useEffect(() => {
    if (size.w === 0 || size.h === 0) return;
    const [x, y, w, h] = doc.view_box_mm;
    if (w <= 0 || h <= 0) return;
    const padding = 0.9;
    const scale = Math.min(size.w / w, size.h / h) * padding;
    const tx = size.w / 2 - (x + w / 2) * scale;
    const ty = size.h / 2 - (y + h / 2) * scale;
    setTransform({ tx, ty, k: scale });
  }, [doc, size.w, size.h]);

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
    // Only start panning when not clicking on a run.
    if ((e.target as SVGElement).tagName === 'path') return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, tx: transform.tx, ty: transform.ty };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setTransform((t) => ({ ...t, tx: dragRef.current!.tx + dx, ty: dragRef.current!.ty + dy }));
  }

  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (dragRef.current) {
      dragRef.current = null;
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    }
  }

  function onCanvasClick(e: React.MouseEvent<SVGSVGElement>) {
    // If we just finished a drag, the pointerup handler clears dragRef before
    // click fires. Treat clicks on the background as deselect.
    if ((e.target as SVGElement).tagName === 'svg' || (e.target as SVGElement).tagName === 'rect') {
      onSelectRun(null);
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

  return (
    <div ref={containerRef} className="editor-canvas">
      <svg
        width="100%"
        height="100%"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onCanvasClick}
      >
        <rect x={0} y={0} width={size.w} height={size.h} fill="transparent" />
        <g transform={`translate(${transform.tx},${transform.ty}) scale(${transform.k})`}>
          {doc.runs.map((run) => {
            const selected = run.id === selectedRunId;
            return (
              <path
                key={run.id}
                d={polylineToD(run.polyline.points, run.polyline.closed)}
                stroke={selected ? '#ff3b6b' : '#888'}
                strokeWidth={(selected ? 1.5 : 0.6) / transform.k}
                fill="none"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRun(run.id);
                }}
                style={{ cursor: 'pointer' }}
              />
            );
          })}
        </g>
      </svg>
      <div className="canvas-toolbar">
        <button type="button" onClick={fitToView}>Fit</button>
        <span className="meta">
          zoom {(transform.k).toFixed(2)}× · {doc.runs.length} runs · {Math.round(doc.view_box_mm[2])} × {Math.round(doc.view_box_mm[3])}mm
        </span>
      </div>
    </div>
  );
}

function polylineToD(points: [number, number][], closed: boolean): string {
  if (points.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const cmd = i === 0 ? 'M' : 'L';
    parts.push(`${cmd}${points[i][0]} ${points[i][1]}`);
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}
