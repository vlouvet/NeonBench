import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  parseDoc,
  parseReport,
  type DesignDoc,
  type DesignVersion,
  type Project,
  type TubeSpec,
  type ValidationReport,
} from '../api';
import EditorCanvas, { type EditorTool } from '../components/EditorCanvas';
import { defaultDirection } from '../lib/runArcs';
import { NEON_COLORS, colorHex } from '../lib/neonColors';
import { computeBends, effectiveBends } from '../lib/bends';

export default function EditorPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [tubeSpec, setTubeSpec] = useState<TubeSpec | null>(null);
  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [tool, setTool] = useState<EditorTool>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const validateAbortRef = useRef<AbortController | null>(null);

  // Undo/redo: stacks of past/future doc snapshots. Coalescing collapses
  // edits that land within COALESCE_MS of the previous edit into a single
  // undo step — typing into the diameter input or rapid-clicking a tool
  // shouldn't bury a meaningful prior state under 30 trivial entries.
  const undoStackRef = useRef<DesignDoc[]>([]);
  const redoStackRef = useRef<DesignDoc[]>([]);
  const lastPushAtRef = useRef<number>(0);
  const [historyTick, setHistoryTick] = useState(0); // bump to refresh canUndo/canRedo
  const COALESCE_MS = 500;
  const HISTORY_CAP = 50;

  function resetHistory() {
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastPushAtRef.current = 0;
    setHistoryTick((t) => t + 1);
  }

  function editDoc(updater: (prev: DesignDoc) => DesignDoc) {
    setDoc((prev) => {
      if (!prev) return prev;
      const next = updater(prev);
      if (next === prev) return prev;
      const now = Date.now();
      const stack = undoStackRef.current;
      // Coalesce rapid sequential edits into the most-recent undo entry so
      // one Cmd+Z reverts a logical action, not a single keystroke.
      if (stack.length > 0 && now - lastPushAtRef.current < COALESCE_MS) {
        // Replace top: keep the OLDER snapshot already on the stack.
      } else {
        stack.push(prev);
        if (stack.length > HISTORY_CAP) stack.shift();
      }
      lastPushAtRef.current = now;
      // Any new edit invalidates the redo branch.
      redoStackRef.current = [];
      setHistoryTick((t) => t + 1);
      return next;
    });
    setDirty(true);
  }

  function undo() {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    setDoc((cur) => {
      if (!cur) return cur;
      const prev = stack.pop()!;
      redoStackRef.current.push(cur);
      lastPushAtRef.current = 0; // next edit starts a fresh coalesce window
      setHistoryTick((t) => t + 1);
      return prev;
    });
    setDirty(true);
  }

  function redo() {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    setDoc((cur) => {
      if (!cur) return cur;
      const next = stack.pop()!;
      undoStackRef.current.push(cur);
      lastPushAtRef.current = 0;
      setHistoryTick((t) => t + 1);
      return next;
    });
    setDirty(true);
  }

  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;
  void historyTick; // referenced so React tracks the dependency for the booleans above

  useEffect(() => {
    Promise.all([
      api.getProject(projectId),
      api.getDesignVersion(projectId, versionId),
      api.listTubeSpecs(),
    ])
      .then(([p, v, specs]) => {
        setProject(p);
        setVersion(v);
        setDoc(parseDoc(v));
        setReport(parseReport(v));
        setTubeSpec(specs.find((s) => s.id === p.tube_spec_id) ?? null);
        setDirty(false);
        resetHistory();
      })
      .catch((e: Error) => setError(e.message));
    // resetHistory has stable identity via refs and is intentionally omitted
    // from deps to avoid re-running on every history bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, versionId]);

  // Keyboard shortcuts: Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo. Skipped
  // when the user is typing into an input — otherwise an editor undo would
  // hijack input field text undo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced live validation: every meaningful edit kicks a 500ms timer;
  // when it fires we submit the current doc to the server. In-flight calls
  // are aborted on the next tick so the user only ever sees the result of
  // their latest state. Skipped when the doc is clean (the saved report is
  // already authoritative).
  useEffect(() => {
    if (!doc || !dirty) return;
    const handle = window.setTimeout(() => {
      validateAbortRef.current?.abort();
      const ctrl = new AbortController();
      validateAbortRef.current = ctrl;
      setValidating(true);
      api
        .validateDoc(projectId, doc, ctrl.signal)
        .then((rep) => {
          if (!ctrl.signal.aborted) setReport(rep);
        })
        .catch((e: Error) => {
          if (!ctrl.signal.aborted) {
            // Surface but don't crash the editor — validation is advisory.
            setError(`live validate: ${e.message}`);
          }
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setValidating(false);
        });
    }, 500);
    return () => {
      window.clearTimeout(handle);
    };
  }, [doc, dirty, projectId]);

  if (error) return <p className="error">{error}</p>;
  if (!project || !version) return <p className="meta">Loading…</p>;
  if (!doc) {
    return (
      <section>
        <p>
          <Link to={`/projects/${projectId}`}>&larr; {project.name}</Link>
        </p>
        <h1>Editor — v{version.version_no}</h1>
        <p className="error">
          This version was created before the editor schema existed. Re-vectorize on
          the project page to generate an editable design doc.
        </p>
      </section>
    );
  }

  function placeElectrode(runId: string, pointIndex: number) {
    if (!doc) return;
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const existing = run.electrodes ?? [];
        let nextElectrodes;
        if (existing.length >= 2) {
          // Replace the closer of the two existing electrodes.
          const dist = (idx: number) => Math.abs(idx - pointIndex);
          const replaceIdx = dist(existing[0].point_index) < dist(existing[1].point_index) ? 0 : 1;
          nextElectrodes = [...existing];
          nextElectrodes[replaceIdx] = { point_index: pointIndex };
        } else {
          nextElectrodes = [...existing, { point_index: pointIndex }];
        }
        const next = { ...run, electrodes: nextElectrodes };
        // When we just gave a closed run its second electrode, default the
        // direction to whichever arc is longer (typically the visible part
        // of a glyph perimeter).
        if (run.polyline.closed && nextElectrodes.length === 2 && !run.direction) {
          next.direction = defaultDirection(next);
        }
        return next;
      });
      return { ...prev, runs };
    });
    setSelected(runId);
  }

  function flipDirection(runId: string) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const cur = run.direction ?? defaultDirection(run);
        const next: 'forward' | 'backward' = cur === 'forward' ? 'backward' : 'forward';
        return { ...run, direction: next };
      });
      return { ...prev, runs };
    });
  }

  function deleteElectrode(runId: string, electrodeIndex: number) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const electrodes = (run.electrodes ?? []).filter((_, i) => i !== electrodeIndex);
        return { ...run, electrodes };
      });
      return { ...prev, runs };
    });
  }

  function clearElectrodesOnSelected() {
    if (!selected) return;
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((r) => (r.id === selected ? { ...r, electrodes: [] } : r)),
    }));
  }

  function placeBlockout(runId: string, startLiveIndex: number, endLiveIndex: number) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        // Normalize so start <= end for non-wrapping intent. (For closed runs
        // the renderer will still walk the live arc the right way around.)
        const s = Math.min(startLiveIndex, endLiveIndex);
        const e = Math.max(startLiveIndex, endLiveIndex);
        const blockouts = [...(run.blockouts ?? []), { start_live_index: s, end_live_index: e }];
        return { ...run, blockouts };
      });
      return { ...prev, runs };
    });
    setSelected(runId);
  }

  function deleteBlockout(runId: string, blockoutIndex: number) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const blockouts = (run.blockouts ?? []).filter((_, i) => i !== blockoutIndex);
        return { ...run, blockouts };
      });
      return { ...prev, runs };
    });
  }

  function clearBlockoutsOnSelected() {
    if (!selected) return;
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((r) => (r.id === selected ? { ...r, blockouts: [] } : r)),
    }));
  }

  function setRunColor(runId: string, color: string) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        // Empty value collapses to omitted field so the JSON stays clean.
        if (color === '') {
          const { color: _drop, ...rest } = run;
          return rest;
        }
        return { ...run, color };
      });
      return { ...prev, runs };
    });
  }

  function placeAnnotation(runId: string, kind: 'jump' | 'support' | 'doubleback', liveIndex: number) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const annotations = [...(run.annotations ?? []), { kind, live_index: liveIndex }];
        return { ...run, annotations };
      });
      return { ...prev, runs };
    });
    setSelected(runId);
  }

  function deleteAnnotation(runId: string, annotationIndex: number) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const annotations = (run.annotations ?? []).filter((_, i) => i !== annotationIndex);
        return { ...run, annotations };
      });
      return { ...prev, runs };
    });
  }

  function clearAnnotationsOnSelected() {
    if (!selected) return;
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((r) => (r.id === selected ? { ...r, annotations: [] } : r)),
    }));
  }

  function placeBend(runId: string, liveIndex: number) {
    editDoc((prev) => {
      const projDiam = tubeSpec?.diameter_mm ?? 10;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        // First manual add snapshots the current auto-detected list so the
        // user can edit on top of it instead of starting from blank.
        const seed = run.bends && run.bends.length > 0
          ? run.bends
          : computeBends(run, projDiam).map((b) => ({ live_index: b.liveIndex }));
        // Avoid trivial duplicates within a few samples of an existing bend.
        if (seed.some((b) => Math.abs(b.live_index - liveIndex) < 2)) {
          return { ...run, bends: seed };
        }
        const bends = [...seed, { live_index: liveIndex }].sort(
          (a, b) => a.live_index - b.live_index,
        );
        return { ...run, bends };
      });
      return { ...prev, runs };
    });
    setSelected(runId);
  }

  function deleteBend(runId: string, bendIndex: number) {
    editDoc((prev) => {
      const projDiam = tubeSpec?.diameter_mm ?? 10;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const seed = run.bends && run.bends.length > 0
          ? run.bends
          : computeBends(run, projDiam).map((b) => ({ live_index: b.liveIndex }));
        const bends = seed.filter((_, i) => i !== bendIndex);
        return { ...run, bends };
      });
      return { ...prev, runs };
    });
  }

  function resetBendsOnSelected() {
    if (!selected) return;
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((r) => {
        if (r.id !== selected) return r;
        const { bends: _drop, ...rest } = r;
        return rest;
      }),
    }));
  }

  function placeLabel(x: number, y: number) {
    const text = window.prompt('Label text:', '')?.trim();
    if (!text) return;
    editDoc((prev) => ({
      ...prev,
      labels: [...(prev.labels ?? []), { x, y, text }],
    }));
  }

  function deleteLabel(index: number) {
    editDoc((prev) => ({
      ...prev,
      labels: (prev.labels ?? []).filter((_, i) => i !== index),
    }));
  }

  function placeDimension(x1: number, y1: number, x2: number, y2: number) {
    if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return; // ignore misclicks <0.5mm apart
    const note = window.prompt('Optional note (blank to skip):', '')?.trim() || undefined;
    editDoc((prev) => ({
      ...prev,
      dimensions: [...(prev.dimensions ?? []), { x1, y1, x2, y2, ...(note ? { note } : {}) }],
    }));
  }

  function deleteDimension(index: number) {
    editDoc((prev) => ({
      ...prev,
      dimensions: (prev.dimensions ?? []).filter((_, i) => i !== index),
    }));
  }

  function moveVertex(runId: string, pointIndex: number, x: number, y: number) {
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const points = run.polyline.points.slice();
        if (pointIndex < 0 || pointIndex >= points.length) return run;
        if (points[pointIndex][0] === x && points[pointIndex][1] === y) return run;
        points[pointIndex] = [x, y];
        return { ...run, polyline: { ...run.polyline, points } };
      }),
    }));
  }

  function deleteVertex(runId: string, pointIndex: number) {
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((run) => {
        if (run.id !== runId) return run;
        // Closed polylines need at least 3 points to remain meaningful;
        // open polylines need at least 2.
        const minPts = run.polyline.closed ? 3 : 2;
        if (run.polyline.points.length <= minPts) return run;
        const points = run.polyline.points.filter((_, i) => i !== pointIndex);
        // Electrodes / blockouts / annotations / bends reference indices
        // that may have shifted. Drop entries that pointed at the deleted
        // vertex, and decrement any that pointed past it.
        const shift = (i: number) => (i > pointIndex ? i - 1 : i);
        const electrodes = (run.electrodes ?? [])
          .filter((e) => e.point_index !== pointIndex)
          .map((e) => ({ ...e, point_index: shift(e.point_index) }));
        return {
          ...run,
          polyline: { ...run.polyline, points },
          electrodes,
        };
      }),
    }));
  }

  function setRunNotes(runId: string, notes: string) {
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((r) => {
        if (r.id !== runId) return r;
        if (notes.trim() === '') {
          const { notes: _drop, ...rest } = r;
          return rest;
        }
        return { ...r, notes };
      }),
    }));
  }

  function setRunDiameter(runId: string, diameterMM: number | null) {
    editDoc((prev) => {
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        if (diameterMM == null || Number.isNaN(diameterMM) || diameterMM <= 0) {
          const { tube_diameter_mm: _drop, ...rest } = run;
          return rest;
        }
        return { ...run, tube_diameter_mm: diameterMM };
      });
      return { ...prev, runs };
    });
  }

  async function save() {
    if (!doc) return;
    setSaving(true);
    setError(null);
    try {
      const newVersion = await api.saveDesignVersion(projectId, {
        based_on_vid: versionId,
        label: label.trim() || undefined,
        design_doc: doc,
      });
      navigate(`/projects/${projectId}/edit/${newVersion.id}`, { replace: true });
      setDirty(false);
      setLabel('');
      // Saved baseline = clean state; clear undo history so users don't undo
      // back through changes that are already persisted as a new version.
      resetHistory();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selectedRun = doc.runs.find((r) => r.id === selected) ?? null;
  const totalElectrodes = doc.runs.reduce((acc, r) => acc + (r.electrodes?.length ?? 0), 0);

  return (
    <section className="editor-section">
      <header className="editor-header">
        <p>
          <Link to={`/projects/${projectId}`}>&larr; {project.name}</Link>
        </p>
        <div className="row">
          <h1>
            Editor — v{version.version_no}
            {version.label ? ` · ${version.label}` : ''}
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </h1>
          <div className="editor-toolbar">
            <button
              type="button"
              className="tool-btn"
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Cmd/Ctrl+Z)"
            >Undo</button>
            <button
              type="button"
              className="tool-btn"
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Cmd/Ctrl+Shift+Z)"
            >Redo</button>
            <span className="toolbar-divider" aria-hidden />
            <button
              type="button"
              className={tool === 'select' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('select')}
              title="Select tool (click runs to highlight)"
            >Select</button>
            <button
              type="button"
              className={tool === 'electrode' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('electrode')}
              title="Place electrode (click on a path)"
            >Place electrode</button>
            <button
              type="button"
              className={tool === 'blockout' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('blockout')}
              title="Mark blockout (click two points on the same run)"
            >Mark blockout</button>
            <button
              type="button"
              className={tool === 'jump' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('jump')}
              title="Mark a jump-over (tube lifts to clear another tube)"
            >Mark jump</button>
            <button
              type="button"
              className={tool === 'support' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('support')}
              title="Mark a support point (chassis-mount)"
            >Mark support</button>
            <button
              type="button"
              className={tool === 'doubleback' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('doubleback')}
              title="Mark a hairpin as an intentional double-back (suppresses bend-radius warning)"
            >Mark double-back</button>
            <button
              type="button"
              className={tool === 'bend' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('bend')}
              title="Add a manual bend point (overrides auto-detect for that run)"
            >Add bend</button>
            <span className="toolbar-divider" aria-hidden />
            <button
              type="button"
              className={tool === 'label' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('label')}
              title="Drop a text label anywhere on the canvas"
            >Label</button>
            <button
              type="button"
              className={tool === 'dimension' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('dimension')}
              title="Measure a distance between two points (click two points)"
            >Dimension</button>
            <button
              type="button"
              className={tool === 'node' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('node')}
              title="Edit polyline vertices on the selected run (drag to move, shift-click to delete)"
            >Node edit</button>
          </div>
        </div>
        <p className="meta">
          {doc.runs.length} runs · {totalElectrodes} electrodes placed · drag to pan, wheel to zoom · shift+click an electrode to delete
        </p>
        <ValidationBadge report={report} validating={validating} />
      </header>
      <div className="editor-layout">
        <EditorCanvas
          doc={doc}
          tool={tool}
          selectedRunId={selected}
          projectDiameterMM={tubeSpec?.diameter_mm ?? 10}
          onSelectRun={setSelected}
          onPlaceElectrode={placeElectrode}
          onDeleteElectrode={deleteElectrode}
          onPlaceBlockout={placeBlockout}
          onPlaceAnnotation={placeAnnotation}
          onDeleteAnnotation={deleteAnnotation}
          onPlaceBend={placeBend}
          onPlaceLabel={placeLabel}
          onPlaceDimension={placeDimension}
          onDeleteLabel={deleteLabel}
          onDeleteDimension={deleteDimension}
          onMoveVertex={moveVertex}
          onDeleteVertex={deleteVertex}
        />
        <aside className="editor-sidebar">
          <h3>Runs</h3>
          <ul className="run-list">
            {doc.runs.map((run) => {
              const ne = run.electrodes?.length ?? 0;
              return (
                <li
                  key={run.id}
                  className={`run-row ${run.id === selected ? 'active' : ''}`}
                  onClick={() => setSelected(run.id)}
                >
                  <div className="run-row-head">
                    <span
                      className="color-swatch"
                      style={{ background: colorHex(run.color) }}
                      title={run.color || 'unassigned'}
                    />
                    <strong>{run.id}</strong>
                  </div>
                  <span className="meta">
                    {run.polyline.points.length} pts · {ne}/2 ⬥ · ø {run.tube_diameter_mm ?? '?'}mm
                  </span>
                </li>
              );
            })}
          </ul>
          {selectedRun && (
            <div className="run-detail">
              <h4>{selectedRun.id}</h4>
              <p className="meta">
                {selectedRun.polyline.points.length} pts ·{' '}
                {selectedRun.polyline.closed ? 'closed' : 'open'} ·{' '}
                {selectedRun.electrodes?.length ?? 0} electrodes
              </p>
              <label className="color-picker">
                Color
                <select
                  value={selectedRun.color ?? ''}
                  onChange={(e) => setRunColor(selectedRun.id, e.target.value)}
                >
                  {NEON_COLORS.map((c) => (
                    <option key={c.value || 'unset'} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span
                  className="color-swatch lg"
                  style={{ background: colorHex(selectedRun.color) }}
                />
              </label>
              <label className="diameter-picker">
                Diameter (mm)
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  value={selectedRun.tube_diameter_mm ?? ''}
                  placeholder="project default"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    setRunDiameter(selectedRun.id, raw === '' ? null : Number(raw));
                  }}
                />
              </label>
              <p className="meta hint-line">
                Editor-only override. Validation still uses the project tube spec.
              </p>
              <label className="run-notes">
                Notes
                <textarea
                  rows={3}
                  value={selectedRun.notes ?? ''}
                  placeholder="e.g. 15kV @ 60mA, GTO HV cable, argon+phosphor"
                  onChange={(e) => setRunNotes(selectedRun.id, e.target.value)}
                />
              </label>
              {selectedRun.polyline.closed && (selectedRun.electrodes?.length ?? 0) === 2 && (
                <button type="button" className="btn-secondary" onClick={() => flipDirection(selectedRun.id)}>
                  Switch live arc ({selectedRun.direction ?? 'forward'})
                </button>
              )}
              {(selectedRun.electrodes?.length ?? 0) > 0 && (
                <button type="button" className="btn-secondary" onClick={clearElectrodesOnSelected}>
                  Clear electrodes
                </button>
              )}
              {(selectedRun.blockouts?.length ?? 0) > 0 && (
                <>
                  <h5 className="meta">Blockouts</h5>
                  <ul className="blockout-list">
                    {selectedRun.blockouts!.map((b, bi) => (
                      <li key={bi}>
                        <span className="meta">[{b.start_live_index}, {b.end_live_index}]</span>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => deleteBlockout(selectedRun.id, bi)}
                        >Remove</button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn-secondary" onClick={clearBlockoutsOnSelected}>
                    Clear blockouts
                  </button>
                </>
              )}
              {(() => {
                const bends = effectiveBends(selectedRun, tubeSpec?.diameter_mm ?? 10);
                const isManual = !!selectedRun.bends && selectedRun.bends.length > 0;
                if (bends.length === 0 && !isManual) {
                  return (
                    <p className="meta hint-line">
                      Bends: none auto-detected (smooth curves below 20° turn).
                    </p>
                  );
                }
                return (
                  <>
                    <h5 className="meta">
                      Bends · {bends.length} · total{' '}
                      {bends.reduce((acc, b) => acc + b.angleDeg, 0).toFixed(0)}°
                      {isManual ? ' · manual' : ' · auto'}
                    </h5>
                    <ul className="blockout-list">
                      {bends.map((b, bi) => (
                        <li key={bi}>
                          <span className="meta">
                            #{bi + 1} @ {b.arcLengthMM.toFixed(1)}mm · {b.angleDeg.toFixed(0)}° · r={b.radiusMM > 0 && Number.isFinite(b.radiusMM) ? `${b.radiusMM.toFixed(1)}mm` : '∞'}
                          </span>
                          <button
                            type="button"
                            className="btn-link"
                            onClick={() => deleteBend(selectedRun.id, bi)}
                          >Remove</button>
                        </li>
                      ))}
                    </ul>
                    {isManual && (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={resetBendsOnSelected}
                      >Reset to auto</button>
                    )}
                  </>
                );
              })()}
              {(selectedRun.annotations?.length ?? 0) > 0 && (
                <>
                  <h5 className="meta">Annotations</h5>
                  <ul className="blockout-list">
                    {selectedRun.annotations!.map((a, ai) => (
                      <li key={ai}>
                        <span className="meta">{a.kind} @ live {a.live_index}</span>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => deleteAnnotation(selectedRun.id, ai)}
                        >Remove</button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn-secondary" onClick={clearAnnotationsOnSelected}>
                    Clear annotations
                  </button>
                </>
              )}
            </div>
          )}
          <div className="save-section">
            <label>
              New version label
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. 'electrodes placed'"
              />
            </label>
            <button
              type="button"
              className={`btn-primary ${dirty ? '' : 'disabled'}`}
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? 'Saving…' : dirty ? 'Save as new version' : 'No changes'}
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ValidationBadge({
  report,
  validating,
}: {
  report: ValidationReport | null;
  validating: boolean;
}) {
  if (!report) {
    return (
      <p className="meta validation-badge">
        {validating ? 'Validating…' : 'No validation report yet — edit to trigger live validation.'}
      </p>
    );
  }
  const errors = report.issues.filter((i) => i.severity === 'error').length;
  const warnings = report.issues.filter((i) => i.severity === 'warning').length;
  const cls = errors > 0 ? 'err' : warnings > 0 ? 'warn' : 'ok';
  const summary =
    errors === 0 && warnings === 0
      ? 'All rules pass'
      : `${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}`;
  return (
    <p className={`meta validation-badge ${cls}`}>
      {validating ? 'Re-validating… ' : ''}
      {summary} · {report.tube_runs} runs · {(report.total_length_mm / 1000).toFixed(2)}m total tube
    </p>
  );
}
