import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  parseDoc,
  parseReport,
  type DesignDoc,
  type DesignRun,
  type DesignVersion,
  type Project,
  type TubeSpec,
  type ValidationReport,
} from '../api';
import EditorCanvas, { type EditorTool } from '../components/EditorCanvas';
import HersheyTextDialog from '../components/HersheyTextDialog';
import HousingPickerModal from '../components/HousingPickerModal';
import PrintHost from '../components/PrintHost';
import PrintPopover, { type PrintPopoverValues } from '../components/PrintPopover';
import ValidationReportView, {
  type SeverityFilter,
} from '../components/ValidationReportView';
import { NEON_COLORS, colorHex } from '../lib/neonColors';
import { effectiveBends } from '../lib/bends';
import * as ops from '../lib/docOps';
import { hersheyRunsBBox, type HersheyRun } from '../lib/hershey/text';
import type { HousingType, ElectrodeWithHousing } from '../lib/housingLibrary';

export default function EditorPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [tubeSpec, setTubeSpec] = useState<TubeSpec | null>(null);
  const [allSpecs, setAllSpecs] = useState<TubeSpec[]>([]);
  const [specSwitching, setSpecSwitching] = useState(false);
  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [tool, setToolRaw] = useState<EditorTool>('select');
  // Tier 3 #33a — multi-select. The selection is editor state (not
  // persisted in the design doc). Click replaces; Shift/Cmd-click
  // toggles; Cmd-A selects every run; Esc clears. The "primary"
  // selected run for the run-detail panel is the LAST entry (the
  // most recently clicked) — that mirrors macOS Finder's "last item
  // wins" pattern when sidebar fields show one-run-at-a-time data.
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  // Selection helpers. setSelectedToOne is the common case (click,
  // post-op auto-select). selectMany / clearSelection are for the
  // Cmd-A and Esc paths. The toggle helper drives Shift/Cmd-click.
  function setSelectedToOne(id: string) {
    setSelectedRunIds([id]);
  }
  function clearSelection() {
    setSelectedRunIds([]);
  }
  function toggleSelection(id: string) {
    setSelectedRunIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }
  function selectAllRuns() {
    setSelectedRunIds((prev) => {
      const everyId = (doc?.runs ?? []).map((r) => r.id);
      // No-op if already-everything selected so we don't churn renders.
      if (everyId.length === prev.length && everyId.every((id) => prev.includes(id))) {
        return prev;
      }
      return everyId;
    });
  }
  // Canvas click handler: routes to replace-or-toggle based on the
  // modifier keys (Shift/Cmd-Ctrl). Passed in to EditorCanvas which
  // owns the click-on-run / click-background events.
  //
  // Tier 3 #33b — plain click on a grouped run extends the selection
  // to every run sharing the same `group_id` (the group is "one
  // logical unit" from the operator's POV). Shift/Cmd still toggles
  // ONLY the clicked run — the modifier semantics from 33a are
  // preserved so the operator can pluck individual members out of a
  // group when they need to.
  function handleSelectRun(id: string | null, opts?: { additive?: boolean }) {
    if (id === null) {
      clearSelection();
      return;
    }
    if (opts?.additive) {
      toggleSelection(id);
      return;
    }
    const clicked = doc?.runs.find((r) => r.id === id);
    if (clicked?.group_id) {
      const memberIds = (doc?.runs ?? [])
        .filter((r) => r.group_id === clicked.group_id)
        .map((r) => r.id);
      setSelectedRunIds(memberIds);
      return;
    }
    setSelectedToOne(id);
  }
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const validateAbortRef = useRef<AbortController | null>(null);
  // Tier 3 #47 — marker overlay polish.
  //
  // hoveredIssueIndex: the index INTO the FILTERED issue list of the
  //   marker / row currently under the cursor. Both subcomponents
  //   write to it (via callbacks) and read from it (as a prop) so the
  //   sidebar and canvas highlight in lock-step.
  // selectedIssueIndex: separate "j/k cursor" — survives mouse-leave
  //   so keyboard nav can advance from where the user last clicked.
  // severityFilter: component-local. Unchecking either box hides those
  //   markers from the canvas AND the matching rows from the sidebar.
  // centerOnIssue: epoch-bumping pan-zoom command for the canvas. The
  //   canvas's useEffect compares epoch and re-runs the tween only on
  //   change.
  const [hoveredIssueIndex, setHoveredIssueIndex] = useState<number | null>(null);
  const [selectedIssueIndex, setSelectedIssueIndex] = useState<number | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>({
    errors: true,
    warnings: true,
  });
  const [centerOnIssue, setCenterOnIssue] = useState<{
    x: number;
    y: number;
    epoch: number;
  } | null>(null);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [snapMM, setSnapMM] = useState(1);
  const [hersheyOpen, setHersheyOpen] = useState(false);
  // Tier 3 #62 — housing-picker modal target. Non-null when the
  // operator right-clicked an electrode pin; carries enough context
  // (run id + electrode index within run.electrodes) for the modal
  // to read the existing housing fields off the doc and emit a
  // setElectrodeHousing op on Save.
  const [housingTarget, setHousingTarget] = useState<{
    runId: string;
    electrodeIndex: number;
  } | null>(null);
  // Print-via-OS-dialog state (Tier 3 #32). When non-null, a hidden
  // iframe loads the print PDF and triggers `window.print()` against
  // it. Cleared once the print dialog closes so the iframe unmounts.
  // We snapshot the URL so changing tube-spec / paper after clicking
  // Print doesn't yank the iframe content mid-spool.
  const [printSrc, setPrintSrc] = useState<string | null>(null);
  // Tier 3 #52 — popover state for the Print button. Defaults match
  // <PrintPanel> on ProjectDetail (US Letter, portrait, full pattern)
  // so the toolbar Print and the project-page download produce the
  // same PDF when the operator hasn't fiddled with the dropdown.
  const [printPopoverOpen, setPrintPopoverOpen] = useState(false);
  const [printOpts, setPrintOpts] = useState<PrintPopoverValues>({
    paper: 'letter',
    landscape: false,
    stripsOnly: false,
  });
  const printGroupRef = useRef<HTMLDivElement | null>(null);
  // Join-arming state for the node tool: stores the first endpoint the
  // user picked (via the "Join from head/tail" sidebar buttons). The
  // second click in the canvas commits the join + clears this.
  const [joinArm, setJoinArm] = useState<{ runId: string; endpoint: 'head' | 'tail' } | null>(null);
  // Wrapped tool setter — clears the join-arm whenever the user leaves
  // the node tool so a stale arm doesn't ambush them when they come
  // back. Inline (rather than via an effect) so we don't trip the
  // setState-in-effect lint rule.
  function setTool(next: EditorTool) {
    setToolRaw((prev) => {
      if (prev === 'node' && next !== 'node') setJoinArm(null);
      return next;
    });
  }

  // Undo/redo: stacks of past/future doc snapshots. Coalescing collapses
  // edits that land within COALESCE_MS of the previous edit into a single
  // undo step — typing into the diameter input or rapid-clicking a tool
  // shouldn't bury a meaningful prior state under 30 trivial entries.
  //
  // The stacks live on refs (mutable, no re-render on push/pop), but the
  // sidebar's Undo/Redo buttons read canUndo / canRedo, which need to be
  // derived from state — reading ref.current during render is a
  // react-hooks/refs error. We mirror the stack lengths into separate
  // useState slots and update them alongside every push/pop.
  const undoStackRef = useRef<DesignDoc[]>([]);
  const redoStackRef = useRef<DesignDoc[]>([]);
  const lastPushAtRef = useRef<number>(0);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);
  const COALESCE_MS = 500;
  const HISTORY_CAP = 50;

  function resetHistory() {
    undoStackRef.current = [];
    redoStackRef.current = [];
    lastPushAtRef.current = 0;
    setUndoLen(0);
    setRedoLen(0);
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
      setUndoLen(stack.length);
      setRedoLen(0);
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
      setUndoLen(stack.length);
      setRedoLen(redoStackRef.current.length);
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
      setUndoLen(undoStackRef.current.length);
      setRedoLen(stack.length);
      return next;
    });
    setDirty(true);
  }

  const canUndo = undoLen > 0;
  const canRedo = redoLen > 0;

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
        setAllSpecs(specs);
        setTubeSpec(specs.find((s) => s.id === p.tube_spec_id) ?? null);
        setDirty(false);
        resetHistory();
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId, versionId]);

  // Keyboard shortcuts: Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo. Skipped
  // when the user is typing into an input — otherwise an editor undo would
  // hijack input field text undo. Also handles the unmodified single-key
  // tool hotkeys (Tier 3 #61: 'O' for Break/Move Opening).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) {
        if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
          // Tier 3 #61 — toggle Break/Move Opening tool. Pressing while
          // already active reverts to select so the operator can dismiss
          // the tool with the same key.
          e.preventDefault();
          setTool(tool === 'break-open' ? 'select' : 'break-open');
        }
        if (!e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
          // Tier 3 #60 — toggle Connect Tubes tool. Same toggle-back-
          // to-select-on-second-press convention 'O' uses for break/move.
          e.preventDefault();
          setTool(tool === 'connect' ? 'select' : 'connect');
        }
        return;
      }
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
  }, [tool]);

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

  // Esc disarms a pending join (matches the cancel semantics of the
  // other in-progress drawing tools). Tool-change disarm is handled in
  // the tool-button click sites so we don't have to setState in an
  // effect.
  //
  // Tier 3 #33a — Esc also clears multi-select; Cmd-A / Ctrl-A selects
  // every run; Delete / Backspace deletes the selection. All of these
  // skip when the user is typing into an input so the keys keep their
  // text-editing meaning inside form fields.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isFormField =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);
      if (isFormField) return;
      if (e.key === 'Escape') {
        if (joinArm) {
          e.preventDefault();
          setJoinArm(null);
        } else if (selectedRunIds.length > 0) {
          // Esc with no in-progress join: drop the selection. Drawing
          // tools own their own Esc handler in EditorCanvas (returns
          // before this fires, since that handler doesn't preventDefault
          // for empty in-progress shapes — but the no-op is harmless).
          e.preventDefault();
          clearSelection();
        }
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (meta && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        // Cmd-A / Ctrl-A — select every run. Skipped while editing a
        // form field so OS-level "Select All Text" still works.
        e.preventDefault();
        selectAllRuns();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRunIds.length > 0) {
        // Delete / Backspace removes every selected run. Skipped if no
        // selection so a stray keypress doesn't fire a no-op editDoc
        // (would mark the doc dirty for nothing). Inlined here (rather
        // than calling out to a hoisted helper) so the lint checker's
        // "function used before declaration" rule stays happy without
        // having to rearrange the whole component.
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        const ids = new Set(selectedRunIds);
        editDoc((prev) => ({
          ...prev,
          runs: prev.runs.filter((r) => !ids.has(r.id)),
        }));
        clearSelection();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // selectAllRuns / deleteSelected close over `doc` and selection
    // state; relisting the deps keeps the closures fresh as those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinArm, selectedRunIds, doc]);

  // Tier 3 #47 — list of GLOBAL indices (into `report.issues`) of the
  // issues that pass the severity filter. j/k keyboard nav cycles
  // through this list, but every other piece of state stays in
  // global-index space (so the sidebar and canvas don't have to
  // translate). The empty array here is fine — filter-empty just
  // means j/k is a no-op until the operator re-enables a severity.
  const visibleIssueIndices = useMemo(() => {
    if (!report) return [] as number[];
    const out: number[] = [];
    for (let i = 0; i < report.issues.length; i++) {
      const iss = report.issues[i];
      if (iss.severity === 'error' && !severityFilter.errors) continue;
      if (iss.severity === 'warning' && !severityFilter.warnings) continue;
      out.push(i);
    }
    return out;
  }, [report, severityFilter]);

  // When the report changes (live revalidate, version load) the old
  // hovered/selected indexes refer to a stale list. Drop them so the
  // pulse animation doesn't fire on the wrong marker. Implemented
  // with the "previous prop in state" pattern so the reset happens
  // during render rather than in an effect — this avoids the
  // cascading-render hit and keeps react-hooks/set-state-in-effect
  // happy (matches the same pattern used for `prevTool` in
  // EditorCanvas).
  const [prevReport, setPrevReport] = useState<ValidationReport | null>(report);
  if (prevReport !== report) {
    setPrevReport(report);
    if (hoveredIssueIndex !== null) setHoveredIssueIndex(null);
    if (selectedIssueIndex !== null) setSelectedIssueIndex(null);
  }

  // Tier 3 #48 — opt-in migration of pre-PR-#44 docs that still carry
  // `<base>-a` / `<base>-b` (and nested `-a-a`) suffixes from the old
  // splitRun emitter. Memoized so the regex scan runs only on doc
  // change, not on every render. Hoisted up here (rather than next to
  // its dispatcher) because the early-returns below for the loading /
  // error states would otherwise put a hook after a conditional return.
  const hasLegacyRunIds = useMemo(() => {
    if (!doc) return false;
    return doc.runs.some((r) => /-(a|b)(?:-(a|b))*$/.test(r.id));
  }, [doc]);

  // nearestRunForPoint: replicates EditorCanvas's nearestRunId so
  // sidebar-click and j/k can reuse the canvas's "click marker →
  // select run" semantics. Iterates run vertices; cheap for typical
  // signs (≤ a few thousand vertices total).
  function nearestRunForPoint(target: [number, number]): string | null {
    if (!doc) return null;
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
  // jumpToIssue: pan-zoom the canvas to the issue at GLOBAL index
  // `globalIdx` AND select the nearest run (mirrors the canvas-click
  // behavior so sidebar + canvas + j/k all converge on the same UX).
  function jumpToIssue(globalIdx: number) {
    if (!report) return;
    if (globalIdx < 0 || globalIdx >= report.issues.length) return;
    const iss = report.issues[globalIdx];
    const x = iss.x_mm;
    const y = iss.y_mm;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    setSelectedIssueIndex(globalIdx);
    setCenterOnIssue((prev) => ({
      x: x as number,
      y: y as number,
      epoch: (prev?.epoch ?? 0) + 1,
    }));
    const id = nearestRunForPoint([x as number, y as number]);
    if (id) setSelectedToOne(id);
  }

  // Keyboard nav: j / ] = next, k / [ = prev. Cycles through the
  // currently-visible filtered set; skipped while the user is typing
  // in an input so the j key still works as a regular character.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (visibleIssueIndices.length === 0) return;
      let dir: 1 | -1;
      if (e.key === 'j' || e.key === ']') dir = 1;
      else if (e.key === 'k' || e.key === '[') dir = -1;
      else return;
      e.preventDefault();
      // Pressing the key while no issue is selected starts at the
      // first (or last, when going backward) visible issue.
      const cur = selectedIssueIndex;
      const curPos = cur === null ? -1 : visibleIssueIndices.indexOf(cur);
      let nextPos: number;
      if (curPos < 0) {
        nextPos = dir > 0 ? 0 : visibleIssueIndices.length - 1;
      } else {
        nextPos =
          (curPos + dir + visibleIssueIndices.length) %
          visibleIssueIndices.length;
      }
      jumpToIssue(visibleIssueIndices[nextPos]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // jumpToIssue closes over `doc` and `report`; re-binding keeps
    // the closure fresh as those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIssueIndices, selectedIssueIndex, doc, report]);

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

  const projDiam = tubeSpec?.diameter_mm ?? 10;

  function placeElectrode(runId: string, pointIndex: number) {
    if (!doc) return;
    editDoc((prev) => ops.placeElectrode(prev, runId, pointIndex));
    setSelectedToOne(runId);
  }

  function flipDirection(runId: string) {
    editDoc((prev) => ops.flipDirection(prev, runId));
  }

  function deleteElectrode(runId: string, electrodeIndex: number) {
    editDoc((prev) => ops.deleteElectrode(prev, runId, electrodeIndex));
  }

  function clearElectrodesOnSelected() {
    if (selectedRunIds.length === 0) return;
    // Tier 3 #33a — loop over every selected run. Order: array order
    // (most-recently-toggled last). Each call returns a new doc; we
    // chain them inside one editDoc so undo collapses to a single step.
    editDoc((prev) => {
      let next = prev;
      for (const id of selectedRunIds) {
        next = ops.clearElectrodes(next, id);
      }
      return next;
    });
  }

  // Tier 3 #62 — surfaced as a right-click on an electrode pin in the
  // canvas. Just opens the modal with the run+electrode context; the
  // modal's onSave handler dispatches setElectrodeHousing through
  // editDoc so the change goes through the normal undo/dirty plumbing.
  function openHousingPicker(runId: string, electrodeIndex: number) {
    setHousingTarget({ runId, electrodeIndex });
    setSelectedToOne(runId);
  }

  function placeBlockout(runId: string, startLiveIndex: number, endLiveIndex: number) {
    editDoc((prev) => ops.placeBlockout(prev, runId, startLiveIndex, endLiveIndex));
    setSelectedToOne(runId);
  }

  function deleteBlockout(runId: string, blockoutIndex: number) {
    editDoc((prev) => ops.deleteBlockout(prev, runId, blockoutIndex));
  }

  function clearBlockoutsOnSelected() {
    if (selectedRunIds.length === 0) return;
    const ids = new Set(selectedRunIds);
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((r) => (ids.has(r.id) ? { ...r, blockouts: [] } : r)),
    }));
  }

  function setRunColor(runId: string, color: string) {
    // Tier 3 #33a — when len > 1, apply the new color to every selected
    // run; the picker UI sits on the primary run's swatch, but the
    // operator's intent reads as "color the selection".
    if (selectedRunIds.length > 1 && selectedRunIds.includes(runId)) {
      editDoc((prev) => {
        let next = prev;
        for (const id of selectedRunIds) {
          next = ops.setRunColor(next, id, color);
        }
        return next;
      });
      return;
    }
    editDoc((prev) => ops.setRunColor(prev, runId, color));
  }

  function placeAnnotation(runId: string, kind: 'jump' | 'support' | 'doubleback', liveIndex: number) {
    editDoc((prev) => ops.placeAnnotation(prev, runId, kind, liveIndex));
    setSelectedToOne(runId);
  }

  function deleteAnnotation(runId: string, annotationIndex: number) {
    editDoc((prev) => ops.deleteAnnotation(prev, runId, annotationIndex));
  }

  function clearAnnotationsOnSelected() {
    if (selectedRunIds.length === 0) return;
    const ids = new Set(selectedRunIds);
    editDoc((prev) => ({
      ...prev,
      runs: prev.runs.map((r) => (ids.has(r.id) ? { ...r, annotations: [] } : r)),
    }));
  }

  function placeBend(runId: string, liveIndex: number) {
    editDoc((prev) => ops.placeBend(prev, runId, liveIndex, projDiam));
    setSelectedToOne(runId);
  }

  function deleteBend(runId: string, bendIndex: number) {
    editDoc((prev) => ops.deleteBend(prev, runId, bendIndex, projDiam));
  }

  function resetBendsOnSelected() {
    if (selectedRunIds.length === 0) return;
    editDoc((prev) => {
      let next = prev;
      for (const id of selectedRunIds) {
        next = ops.resetBends(next, id);
      }
      return next;
    });
  }

  function placeLabel(x: number, y: number) {
    const text = window.prompt('Label text:', '')?.trim();
    if (!text) return;
    editDoc((prev) => ops.placeLabel(prev, x, y, text));
  }

  function deleteLabel(index: number) {
    editDoc((prev) => ops.deleteLabel(prev, index));
  }

  function placeDimension(x1: number, y1: number, x2: number, y2: number) {
    if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return; // ignore misclicks <0.5mm apart
    const note = window.prompt('Optional note (blank to skip):', '')?.trim() || undefined;
    editDoc((prev) => ops.placeDimension(prev, x1, y1, x2, y2, note));
  }

  function deleteDimension(index: number) {
    editDoc((prev) => ops.deleteDimension(prev, index));
  }

  function moveVertex(runId: string, pointIndex: number, x: number, y: number) {
    editDoc((prev) => ops.moveVertex(prev, runId, pointIndex, x, y));
  }

  // Tier 3 #48 — multi-vertex drag committer. The canvas already
  // computed the per-vertex target XY; we hand the batch to docOps in
  // one shot so undo collapses to a single entry.
  function moveVertices(
    runId: string,
    writes: { pointIndex: number; x: number; y: number }[],
  ) {
    editDoc((prev) => ops.moveVertices(prev, runId, writes));
  }

  // Tier 3 #48 — vertex-merge on drop committer. The canvas only fires
  // this when the dropped vertex landed inside the snap-to-vertex
  // radius of `keepIndex` — kicking the dropped vertex's references
  // onto the kept one (see docOps.mergeVertices).
  function mergeVerticesOnRun(runId: string, keepIndex: number, dropIndex: number) {
    editDoc((prev) => ops.mergeVertices(prev, runId, keepIndex, dropIndex));
  }

  function deleteVertex(runId: string, pointIndex: number) {
    editDoc((prev) => ops.deleteVertex(prev, runId, pointIndex));
  }

  function insertVertex(runId: string, segmentIndex: number, t: number) {
    editDoc((prev) => ops.insertVertex(prev, runId, segmentIndex, t));
    setSelectedToOne(runId);
  }

  function splitRun(runId: string, pointIndex: number) {
    editDoc((prev) => ops.splitRun(prev, runId, pointIndex));
    // After split, the original id no longer exists. Select the first
    // half so the user keeps a meaningful selection.
    setSelectedToOne(`${runId}-a`);
    setJoinArm(null);
  }

  function armJoin(runId: string, endpoint: 'head' | 'tail') {
    setJoinArm({ runId, endpoint });
  }

  function pickJoinEndpoint(runId: string, endpoint: 'head' | 'tail') {
    if (!joinArm) return; // sidebar should have armed first
    const a = joinArm;
    setJoinArm(null);
    editDoc((prev) => ops.joinRuns(prev, a.runId, a.endpoint, runId, endpoint));
    setSelectedToOne(a.runId);
  }


  function insertDoubleback(runId: string, segmentIndex: number, t: number, side: 'left' | 'right') {
    // Default depth = 1.5× tube ø, gap = 1.0× tube ø. We honor a per-run
    // diameter override before falling back to the project's tube spec
    // diameter — same precedence the validator uses.
    const run = doc?.runs.find((r) => r.id === runId);
    const diam = run?.tube_diameter_mm ?? projDiam;
    const depth = 1.5 * diam;
    const gap = 1.0 * diam;
    editDoc((prev) =>
      ops.insertDoubleback(prev, runId, segmentIndex, t, depth, gap, side),
    );
    setSelectedToOne(runId);
  }

  // Tier 3 #61 (NW #130) — break-open / move-opening dispatchers.
  // EditorCanvas's `'break-open'` tool routes a click on a closed run
  // here, and a click on an open run with two electrodes through the
  // sibling `moveOpening` dispatcher. Both ops throw OperationError on
  // an invalid input — the canvas only fires the matching handler so
  // the throws shouldn't surface in normal use, but we still surface
  // them to the user via setError so a stale doc state doesn't lead to
  // a silent no-op.
  function breakOpenOnRun(runId: string, vertexIndex: number) {
    try {
      editDoc((prev) => ops.breakOpen(prev, runId, vertexIndex));
      setSelectedToOne(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function moveOpeningOnRun(runId: string, newStartVertexIndex: number) {
    try {
      editDoc((prev) => ops.moveOpening(prev, runId, newStartVertexIndex));
      setSelectedToOne(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Tier 3 #60 (NW #125) — Connect Tubes committer. Wraps docOps's
  // connectTubes with the same OperationError → setError pattern as
  // breakOpenOnRun / moveOpeningOnRun. The new jumper run's id is the
  // next free `j{N}` slot; we select it post-commit so the operator's
  // sidebar reflects what just landed.
  function connectTubesOnRuns(
    fromRunId: string,
    fromElectrodeIdx: number,
    toRunId: string,
    toElectrodeIdx: number,
  ) {
    try {
      let nextRunId: string | null = null;
      editDoc((prev) => {
        const next = ops.connectTubes(
          prev,
          fromRunId,
          fromElectrodeIdx,
          toRunId,
          toElectrodeIdx,
        );
        // The new run is appended; pick it up by id off the new doc
        // so the post-edit selection lands on the jumper.
        const created = next.runs[next.runs.length - 1];
        nextRunId = created?.id ?? null;
        return next;
      });
      if (nextRunId) setSelectedToOne(nextRunId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function setRunNotes(runId: string, notes: string) {
    editDoc((prev) => ops.setRunNotes(prev, runId, notes));
  }

  function setRunDiameter(runId: string, diameterMM: number | null) {
    // Tier 3 #33a — broadcast across the multi-selection so the operator
    // can apply a per-run diameter override to a whole face's worth of
    // runs in one input. Single-select keeps the existing behavior.
    if (selectedRunIds.length > 1 && selectedRunIds.includes(runId)) {
      editDoc((prev) => {
        let next = prev;
        for (const id of selectedRunIds) {
          next = ops.setRunDiameter(next, id, diameterMM);
        }
        return next;
      });
      return;
    }
    editDoc((prev) => ops.setRunDiameter(prev, runId, diameterMM));
  }

  function setRunChannelLetterFace(runId: string, isFace: boolean) {
    editDoc((prev) => ops.setRunChannelLetterFace(prev, runId, isFace));
  }

  function setRunChannelLetterDepth(runId: string, depthMM: number | null) {
    editDoc((prev) => ops.setRunChannelLetterDepth(prev, runId, depthMM));
  }

  function setRunRacewayID(runId: string, racewayID: string) {
    editDoc((prev) => ops.setRunRacewayID(prev, runId, racewayID));
  }

  // Tier 3 #46 — one-click auto-grouping for raceway IDs. Confirms with
  // the user before overwriting any existing manual labels (the spec
  // calls for destructive-by-default with the confirm dialog as the
  // safety net). The op short-circuits to a no-op doc identity when no
  // face-flagged runs exist, but we already gate the button at the JSX
  // layer so this branch is only taken if the user hits a keyboard
  // shortcut (none today; reserved for follow-up).
  function autoAssignRaceways() {
    if (!doc) return;
    const ok = window.confirm(
      'Replace all raceway IDs with auto-assigned values? Manually labelled runs will be overwritten — Cancel to keep them.',
    );
    if (!ok) return;
    editDoc((prev) => ops.autoAssignRaceways(prev));
  }

  // Tier 3 #48 — `hasLegacyRunIds` memo lives at the top of the
  // component (before the loading/error early-returns) so it's a hook
  // call on every render. The button below toggles visibility off when
  // it's false; the op itself is also a no-op on a clean doc.
  function renameLegacyRunIdsAction() {
    if (!doc) return;
    if (!hasLegacyRunIds) return;
    editDoc((prev) => ops.renameLegacyRunIds(prev));
  }

  // Tier 3 #33b — group helpers. `groupSelected` prompts for a name
  // and binds every selected run into a fresh group; `dissolveGroup` /
  // `renameGroup` flow through editDoc so undo/redo and the dirty
  // flag work the same way as every other doc mutation.
  //
  // Selection follow-up: after grouping, we re-select every member
  // (which is identical to the post-extension state when the user
  // next clicks one of them anyway) so the canvas group outline has
  // immediate visual feedback. After dissolving, the selection stays
  // exactly as it was — the runs themselves are unchanged.
  function groupSelected() {
    if (!doc) return;
    if (selectedRunIds.length < 2) return;
    const defaultName = `Group ${(doc.groups?.length ?? 0) + 1}`;
    const name = window.prompt('Group name:', defaultName);
    if (name == null) return; // Cancel
    const trimmed = name.trim();
    if (trimmed === '') return; // Empty-string also cancels per spec
    const memberIds = selectedRunIds.slice();
    editDoc((prev) => ops.groupRuns(prev, memberIds, trimmed).doc);
    setSelectedRunIds(memberIds);
  }

  function dissolveGroupById(groupId: string) {
    editDoc((prev) => ops.dissolveGroup(prev, groupId));
  }

  function renameGroupById(groupId: string) {
    if (!doc) return;
    const group = (doc.groups ?? []).find((g) => g.id === groupId);
    if (!group) return;
    const next = window.prompt('Rename group:', group.name);
    if (next == null) return;
    const trimmed = next.trim();
    if (trimmed === '' || trimmed === group.name) return;
    editDoc((prev) => ops.renameGroup(prev, groupId, trimmed));
  }

  function simplifySelected(epsilonMM: number) {
    if (selectedRunIds.length === 0) return;
    // Tier 3 #33a — apply Douglas-Peucker to each selected run in
    // selection-order (most-recently-toggled last). Each pass operates on
    // the post-previous-pass doc so the chain stays internally
    // consistent. Coalesces into one undo step.
    editDoc((prev) => {
      let next = prev;
      for (const id of selectedRunIds) {
        next = ops.simplifyRun(next, id, epsilonMM);
      }
      return next;
    });
  }

  function reverseSelected() {
    if (selectedRunIds.length === 0) return;
    editDoc((prev) => {
      let next = prev;
      for (const id of selectedRunIds) {
        next = ops.reverseRun(next, id);
      }
      return next;
    });
  }

  // Neonize replaces the selected run with parallel offset run(s) — the
  // "double-stroke" channel-letter primitive (NW #123/131/141). Default
  // spacing = 2 × tube diameter (Strattman NT Ch.7 shop default).
  //
  // Tier 3 #27 polish:
  //   - Open polylines now produce two parallel runs with butt caps
  //     instead of refusing.
  //   - Self-intersection on the inner offset is auto-trimmed before
  //     returning (heuristic; figure-8 cases still need node editing).
  //   - `stitch` (controlled from a small popover next to the button)
  //     concatenates the two offsets via hairpin U-bends into ONE
  //     continuous run named `<id>-stitched`.
  //   - Per-corner cap-style overrides flow through the docOps API but
  //     have no UI in this PR — see Tier 3 follow-ups.
  function neonizeSelected(opts: { stitch: boolean }) {
    if (selectedRunIds.length === 0) return;
    if (!doc) return;
    // Tier 3 #33a — multi-run neonize. Spacing prompt seeds from the
    // primary run's diameter; the same value is reused for every run
    // in the selection (asking once per run would be hostile). Apply
    // sequentially over a running doc so each call sees the previous
    // call's output. Selection-order = array order. Warnings from any
    // run surface as a combined hint.
    const primary = selectedRunIds[selectedRunIds.length - 1];
    const primaryRun = doc.runs.find((r) => r.id === primary);
    if (!primaryRun) return;
    const defaultSpacing = 2 * (primaryRun.tube_diameter_mm ?? projDiam);
    const spacingStr = window.prompt(
      selectedRunIds.length > 1
        ? `Spacing between the two parallel tubes (mm). Applied to every selected run (${selectedRunIds.length}).`
        : 'Spacing between the two parallel tubes (mm). Tip: stroke width = 2 × tube diameter + spacing.',
      String(defaultSpacing),
    );
    if (spacingStr === null) return;
    const spacing = Number(spacingStr);
    if (!Number.isFinite(spacing) || spacing <= 0) {
      setError('Neonize spacing must be a positive number.');
      return;
    }
    let next = doc;
    const warnings: string[] = [];
    for (const id of selectedRunIds) {
      // Skip ids that vanished mid-loop (defensive — should never
      // happen since neonize replaces by id, but a previous iteration's
      // result might have already destroyed this id when group ops
      // arrive in 33b).
      if (!next.runs.some((r) => r.id === id)) continue;
      const result = ops.neonize(next, id, spacing, { stitch: opts.stitch });
      if (result.warning) warnings.push(`${id}: ${result.warning}`);
      next = result.doc;
    }
    if (warnings.length > 0) setError(warnings.join(' · '));
    else setError(null);
    if (next !== doc) {
      editDoc(() => next);
      // The selected runs were destroyed and replaced. Pick the new
      // ids so the user keeps a sensible selection. Outer-or-stitched
      // depending on the toggle.
      const suffix = opts.stitch ? '-stitched' : '-outer';
      setSelectedRunIds(selectedRunIds.map((id) => `${id}${suffix}`));
    }
  }

  // Drawing tools (pen / rect / circle / arc) hand a finished polyline up
  // here; we wrap it in a DesignRun and let appendRuns assign a stable id
  // following the per-prefix counter convention used by the Hershey tool.
  // Direction / electrodes / annotations are intentionally empty — V1 of
  // the drawing primitives just lays down geometry; the user picks up the
  // existing place-electrode / place-blockout / etc. tools to flesh it
  // out from there.
  function commitShape(
    kind: 'pen' | 'rect' | 'circle' | 'arc',
    points: [number, number][],
    closed: boolean,
  ) {
    if (!doc) return;
    if (points.length < 2) return;
    const run: DesignRun = {
      id: kind, // appendRuns rewrites with `${kind}-N`
      polyline: { points, closed },
    };
    editDoc((prev) => ops.appendRuns(prev, [run], kind));
  }

  // Insert Hershey text strokes into the design as new runs. The dialog
  // generates strokes at origin (0,0); we recenter them to the document
  // viewBox center so the user sees them appear near where they're
  // already looking instead of at an off-canvas corner.
  function insertHersheyText(runs: HersheyRun[]) {
    if (!doc || runs.length === 0) return;
    const bbox = hersheyRunsBBox(runs);
    const [vx, vy, vw, vh] = doc.view_box_mm;
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    const dx = bbox ? cx - (bbox.minX + bbox.maxX) / 2 : cx;
    const dy = bbox ? cy - (bbox.minY + bbox.maxY) / 2 : cy;
    const designRuns = runs.map<DesignRun>((r) => ({
      id: 'text', // appendRuns rewrites with a unique `text-N` id
      polyline: {
        points: r.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
        closed: false,
      },
    }));
    editDoc((prev) => ops.appendRuns(prev, designRuns, 'text'));
    setHersheyOpen(false);
  }

  // Switching the project's tube spec from inside the editor needs to do
  // two things atomically from the user's perspective: persist the new
  // tube_spec_id, then re-run validation against the *new* spec so the
  // displayed errors/warnings stop reflecting the old bend-radius/spacing
  // limits. Without the revalidate the user would silently see a stale
  // (and possibly falsely-green) report. The dropdown is disabled while
  // either request is in flight to avoid double-fires.
  async function changeTubeSpec(nextSpecId: number) {
    if (specSwitching) return;
    if (!project || nextSpecId === project.tube_spec_id) return;
    setSpecSwitching(true);
    setError(null);
    try {
      const updatedProject = await api.updateProject(projectId, { tube_spec_id: nextSpecId });
      setProject(updatedProject);
      setTubeSpec(allSpecs.find((s) => s.id === updatedProject.tube_spec_id) ?? null);
      const revalidated = await api.revalidate(projectId, versionId);
      setVersion(revalidated);
      setReport(parseReport(revalidated));
    } catch (e) {
      setError(`change tube spec: ${(e as Error).message}`);
    } finally {
      setSpecSwitching(false);
    }
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

  // Tier 3 #33a — primary run for the run-detail panel = LAST selected
  // (most recently clicked or toggled-in). When the operator multi-selects
  // ten runs, the panel still shows one run's fields, but operations
  // dispatched from those fields broadcast across the selection (see
  // setRunColor / setRunDiameter). Single-select keeps the existing UX.
  const primaryRunId = selectedRunIds.length > 0
    ? selectedRunIds[selectedRunIds.length - 1]
    : null;
  const selectedRun = primaryRunId
    ? (doc.runs.find((r) => r.id === primaryRunId) ?? null)
    : null;
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
              className={tool === 'insert-doubleback' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('insert-doubleback')}
              title="Splice a U-shaped hairpin into a polyline at the click point (default depth 1.5× tube ø, shift-click to flip side)"
            >Insert DB</button>
            <button
              type="button"
              className={tool === 'connect' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('connect')}
              title="Connect tubes (C): click two electrode pins on different runs to commit a jumper run between them. Esc / right-click cancels a staged source."
            >Connect</button>
            <button
              type="button"
              className={tool === 'bend' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('bend')}
              title="Add a manual bend point (overrides auto-detect for that run)"
            >Add bend</button>
            <span className="toolbar-divider" aria-hidden />
            <button
              type="button"
              className={tool === 'pen' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('pen')}
              title="Draw a freeform polyline (click to drop vertices, double-click or Enter to commit, Esc to cancel)"
            >Pen</button>
            <button
              type="button"
              className={tool === 'rect' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('rect')}
              title="Draw an axis-aligned rectangle (drag from corner to corner)"
            >Rect</button>
            <button
              type="button"
              className={tool === 'circle' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('circle')}
              title="Draw a circle (drag from center to radius)"
            >Circle</button>
            <button
              type="button"
              className={tool === 'arc' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('arc')}
              title="Draw a three-point circular arc (click start, mid, end)"
            >Arc</button>
            <button
              type="button"
              className="tool-btn"
              onClick={() => setHersheyOpen(true)}
              title="Insert Hershey single-stroke text as new tube runs"
            >Add text</button>
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
            <button
              type="button"
              className={tool === 'break-open' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('break-open')}
              title="Break/Move Opening (O): click a vertex on a closed run to insert an opening, or on an open run to move the existing opening"
            >Break/Move Opening</button>
            <span className="toolbar-divider" aria-hidden />
            <button
              type="button"
              className={snapEnabled ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setSnapEnabled((v) => !v)}
              title={`Snap labels, dimensions, and vertex drags to a ${snapMM}mm grid`}
            >Snap {snapEnabled ? 'on' : 'off'}</button>
            <input
              type="number"
              step="0.5"
              min="0.1"
              value={snapMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v > 0) setSnapMM(v);
              }}
              className="snap-input"
              title="Snap grid spacing in mm"
            />
            <span className="toolbar-divider" aria-hidden />
            <div className="print-toolbar-group" ref={printGroupRef}>
              <button
                type="button"
                className="tool-btn"
                onClick={() => {
                  // Snapshot the URL up front: the saved version is the
                  // source of truth (live edits aren't persisted), so we
                  // print whatever was last committed under this `vid`.
                  if (dirty) return;
                  setPrintSrc(api.printPDFURL(projectId, versionId, printOpts));
                }}
                disabled={dirty || printSrc !== null}
                title={
                  dirty
                    ? 'Save your edits first — Print uses the last saved version of this design.'
                    : 'Open the OS print dialog with the 1:1 print pattern (PDF). Use the caret to pick paper / landscape / strips-only.'
                }
              >
                {printSrc ? 'Printing…' : 'Print'}
              </button>
              <button
                type="button"
                className={
                  printPopoverOpen
                    ? 'tool-btn print-popover-toggle active'
                    : 'tool-btn print-popover-toggle'
                }
                onClick={() => setPrintPopoverOpen((v) => !v)}
                disabled={dirty || printSrc !== null}
                aria-haspopup="dialog"
                aria-expanded={printPopoverOpen}
                aria-label="Print options"
                title={
                  dirty
                    ? 'Save your edits first — print options are unavailable while there are unsaved changes.'
                    : 'Print options: paper size, landscape, strips only.'
                }
              >
                {/* Down-caret glyph; matches the muted-text colour
                    pulled from var(--text). */}
                {'▾'}
              </button>
              {printPopoverOpen && (
                <PrintPopover
                  values={printOpts}
                  onChange={setPrintOpts}
                  onClose={() => setPrintPopoverOpen(false)}
                  anchorRef={printGroupRef}
                />
              )}
            </div>
          </div>
        </div>
        <p className="meta">
          <label className="editor-tube-spec">
            Tube spec:{' '}
            <select
              value={project.tube_spec_id}
              disabled={specSwitching || allSpecs.length === 0}
              onChange={(e) => changeTubeSpec(Number(e.target.value))}
              title="Switch the project's tube spec. Saves the change and re-runs validation against the new spec."
            >
              {allSpecs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — Ø{s.diameter_mm}mm, min bend {s.min_bend_radius_mm}mm
                </option>
              ))}
            </select>
            {specSwitching && <span className="meta"> · Saving…</span>}
          </label>
          {' · '}
          {doc.runs.length} runs · {totalElectrodes} electrodes placed · drag to pan, wheel to zoom · shift+click an electrode to delete
        </p>
        <ValidationBadge report={report} validating={validating || specSwitching} />
      </header>
      <div className="editor-layout">
        <EditorCanvas
          doc={doc}
          tool={tool}
          selectedRunIds={selectedRunIds}
          projectDiameterMM={tubeSpec?.diameter_mm ?? 10}
          onSelectRun={handleSelectRun}
          onPlaceElectrode={placeElectrode}
          onDeleteElectrode={deleteElectrode}
          onElectrodeContextMenu={openHousingPicker}
          onPlaceBlockout={placeBlockout}
          onPlaceAnnotation={placeAnnotation}
          onDeleteAnnotation={deleteAnnotation}
          onPlaceBend={placeBend}
          onPlaceLabel={placeLabel}
          onPlaceDimension={placeDimension}
          onDeleteLabel={deleteLabel}
          onDeleteDimension={deleteDimension}
          onMoveVertex={moveVertex}
          onMoveVertices={moveVertices}
          onMergeVertices={mergeVerticesOnRun}
          onDeleteVertex={deleteVertex}
          onInsertVertex={insertVertex}
          onSplitRun={splitRun}
          joinArm={joinArm}
          onPickJoinEndpoint={pickJoinEndpoint}
          onInsertDoubleback={insertDoubleback}
          onBreakOpen={breakOpenOnRun}
          onMoveOpening={moveOpeningOnRun}
          onConnectTubes={connectTubesOnRuns}
          onCommitShape={commitShape}
          snapEnabled={snapEnabled}
          snapMM={snapMM}
          validationIssues={report?.issues}
          issueSeverityFilter={severityFilter}
          hoveredIssueIndex={hoveredIssueIndex}
          onIssueHover={setHoveredIssueIndex}
          centerOnIssue={centerOnIssue}
        />
        <aside className="editor-sidebar">
          {/* Tier 3 #47 — Validation issue list lives at the top of
              the sidebar so it's adjacent to the canvas markers
              they're linked to. Severity filter, hover linking, and
              j/k keyboard nav all flow through the props passed in
              here. The list scrolls inside `.editor-sidebar`'s
              overflow:auto so it doesn't push the runs panel off
              screen on dense designs. */}
          {report && (
            <ValidationReportView
              report={report}
              hoveredIssueIndex={hoveredIssueIndex}
              selectedIssueIndex={selectedIssueIndex}
              onIssueHover={setHoveredIssueIndex}
              onIssueClick={jumpToIssue}
              severityFilter={severityFilter}
              onSeverityFilterChange={setSeverityFilter}
            />
          )}
          {/* Tier 3 #33b — Groups bind 2+ runs so they select + transform
              as one logical unit. The "Group selected" button stays
              disabled until at least two runs are selected (a one-run
              "group" is meaningless and would just clutter the list).
              Each existing group exposes inline rename + Dissolve. */}
          <div className="groups-header">
            <h3>Groups ({doc.groups?.length ?? 0})</h3>
            <button
              type="button"
              className="btn-secondary"
              disabled={selectedRunIds.length < 2}
              onClick={groupSelected}
              title="Bind the selected runs into a named group. Clicking any member selects all members; transforms (color, diameter, delete) apply to all."
            >
              Group selected
            </button>
          </div>
          {(doc.groups?.length ?? 0) > 0 && (
            <ul className="group-list">
              {(doc.groups ?? []).map((g) => {
                const memberCount = doc.runs.filter((r) => r.group_id === g.id).length;
                return (
                  <li key={g.id} className="group-row">
                    <button
                      type="button"
                      className="group-name btn-link"
                      onClick={() => renameGroupById(g.id)}
                      title="Click to rename"
                    >
                      {g.name}
                    </button>
                    <span className="meta">
                      {' '}({memberCount} {memberCount === 1 ? 'run' : 'runs'})
                    </span>
                    <button
                      type="button"
                      className="btn-secondary group-dissolve-btn"
                      onClick={() => dissolveGroupById(g.id)}
                      title="Dissolve this group; member runs become independent again."
                    >
                      Dissolve
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="runs-header">
            <h3>Runs</h3>
            <button
              type="button"
              className="btn-secondary auto-raceway-btn"
              disabled={!doc.runs.some((r) => r.is_channel_letter_face)}
              onClick={autoAssignRaceways}
              title="Cluster every channel-letter face run by baseline + horizontal proximity and assign deterministic raceway IDs (raceway-1, raceway-2, …) left-to-right. Overwrites any manually labelled runs after a confirm prompt. Tier 3 #46."
            >
              Auto-group raceways
            </button>
            {/* Tier 3 #48 — opt-in legacy run-id rename. Renders only
                when the doc still carries `<base>-a` / `<base>-b` ids
                from the pre-PR-#44 splitRun emitter; on a clean doc
                the button is suppressed so it doesn't add noise. */}
            {hasLegacyRunIds && (
              <button
                type="button"
                className="btn-secondary"
                onClick={renameLegacyRunIdsAction}
                title="Rewrite legacy `<base>-a` / `<base>-b` run IDs (from split-run before PR #44) to the flat numeric `r1`, `r2`, … scheme. Idempotent — running again on a clean doc is a no-op. Tier 3 #48."
              >
                Rename legacy IDs
              </button>
            )}
          </div>
          <ul className="run-list">
            {doc.runs.map((run) => {
              const ne = run.electrodes?.length ?? 0;
              return (
                <li
                  key={run.id}
                  className={`run-row ${selectedRunIds.includes(run.id) ? 'active' : ''}`}
                  onClick={(e) => {
                    // Tier 3 #33a — sidebar click mirrors canvas click.
                    // Shift / Cmd-Ctrl toggles the run in the selection;
                    // plain click replaces. Letting the operator pick
                    // multiple runs from the sidebar (without first
                    // chasing them on the canvas) matches what they'd
                    // expect from any list view.
                    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
                    handleSelectRun(run.id, { additive });
                  }}
                >
                  <div className="run-row-head">
                    <span
                      className="color-swatch"
                      style={{ background: colorHex(run.color) }}
                      title={run.color || 'unassigned'}
                    />
                    <strong>{run.id}</strong>
                    {run.is_channel_letter_face && (
                      <span
                        className="run-badge"
                        title="Channel-letter face: print PDF emits a return-strip page for this run."
                      >
                        [ch]
                      </span>
                    )}
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
              <div className="run-detail-head">
                <h4>{selectedRun.id}</h4>
                {/* Tier 3 #33a — multi-select badge. The h4 still shows
                    the primary (most-recently-clicked) run id; the badge
                    flags that operations dispatched from the panel below
                    will broadcast across the whole selection. */}
                {selectedRunIds.length >= 2 && (
                  <span
                    className="selection-count"
                    title="Color, diameter, and path-ops below apply to every selected run."
                  >
                    {selectedRunIds.length} selected
                  </span>
                )}
              </div>
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
              <label
                className="run-channel-letter"
                title="Mark this run's polyline as a channel-letter face silhouette. The print PDF will add a return-strip page (perimeter × project depth) with bend marks at every vertex (NW #106)."
              >
                <input
                  type="checkbox"
                  checked={selectedRun.is_channel_letter_face ?? false}
                  onChange={(e) =>
                    setRunChannelLetterFace(selectedRun.id, e.target.checked)
                  }
                />
                {' '}Channel letter face
              </label>
              {selectedRun.is_channel_letter_face && (
                <>
                  <label
                    className="run-channel-letter-depth"
                    title="Optional per-run depth (mm) override for this face's return strip. Empty = use the project default. Lets you mix tall and shallow returns in one project (Tier 3 #26)."
                  >
                    Depth (mm)
                    <input
                      type="number"
                      step="1"
                      min="10"
                      max="500"
                      value={selectedRun.channel_letter_depth_mm ?? ''}
                      placeholder="project default"
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        setRunChannelLetterDepth(
                          selectedRun.id,
                          raw === '' ? null : Number(raw),
                        );
                      }}
                    />
                  </label>
                  <label
                    className="run-raceway-id"
                    title="Optional raceway grouping label. Runs sharing the same value are emitted as ONE combined unfolded return strip on the print PDF (Strattman raceway construction). Empty = ungrouped. Tier 3 #26."
                  >
                    Raceway id
                    <input
                      type="text"
                      maxLength={32}
                      value={selectedRun.raceway_id ?? ''}
                      placeholder="(none — individual strip)"
                      onChange={(e) =>
                        setRunRacewayID(selectedRun.id, e.target.value)
                      }
                    />
                  </label>
                </>
              )}
              <PathOpsRow
                onSimplify={simplifySelected}
                onReverse={reverseSelected}
                onNeonize={(o) => neonizeSelected(o)}
                pointCount={selectedRun.polyline.points.length}
                isClosed={selectedRun.polyline.closed}
              />
              {!selectedRun.polyline.closed && (
                <div className="path-ops-row" title="Arm a join: pick this run's head or tail, then click another open run's endpoint in the canvas (node tool active) to merge them. Cancel by switching tools or pressing Esc.">
                  <span className="meta">Join from</span>
                  <div className="path-ops-buttons">
                    <button
                      type="button"
                      className={
                        joinArm && joinArm.runId === selectedRun.id && joinArm.endpoint === 'head'
                          ? 'btn-secondary active'
                          : 'btn-secondary'
                      }
                      onClick={() => {
                        setTool('node');
                        if (joinArm && joinArm.runId === selectedRun.id && joinArm.endpoint === 'head') {
                          setJoinArm(null);
                        } else {
                          armJoin(selectedRun.id, 'head');
                        }
                      }}
                    >Head</button>
                    <button
                      type="button"
                      className={
                        joinArm && joinArm.runId === selectedRun.id && joinArm.endpoint === 'tail'
                          ? 'btn-secondary active'
                          : 'btn-secondary'
                      }
                      onClick={() => {
                        setTool('node');
                        if (joinArm && joinArm.runId === selectedRun.id && joinArm.endpoint === 'tail') {
                          setJoinArm(null);
                        } else {
                          armJoin(selectedRun.id, 'tail');
                        }
                      }}
                    >Tail</button>
                  </div>
                </div>
              )}
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
      {hersheyOpen && (
        <HersheyTextDialog
          onCancel={() => setHersheyOpen(false)}
          onInsert={(runs) => insertHersheyText(runs)}
        />
      )}
      {housingTarget && (() => {
        const run = doc.runs.find((r) => r.id === housingTarget.runId);
        const electrode = run?.electrodes?.[housingTarget.electrodeIndex] as
          | ElectrodeWithHousing
          | undefined;
        if (!run || !electrode) {
          // Run or electrode disappeared (rare race). Drop the modal so
          // the operator isn't staring at a stale dialog.
          return null;
        }
        const total = run.electrodes?.length ?? 0;
        const caption = `${run.id} · electrode ${housingTarget.electrodeIndex + 1} of ${total}`;
        return (
          <HousingPickerModal
            initial={{
              housing_type: electrode.housing_type as HousingType | undefined,
              bore_diameter_mm: electrode.bore_diameter_mm,
              elevation_mm: electrode.elevation_mm,
            }}
            caption={caption}
            onCancel={() => setHousingTarget(null)}
            onSave={(housing) => {
              try {
                editDoc((prev) =>
                  ops.setElectrodeHousing(
                    prev,
                    housingTarget.runId,
                    housingTarget.electrodeIndex,
                    housing,
                  ),
                );
                setHousingTarget(null);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          />
        );
      })()}
      {printSrc && (
        <PrintHost src={printSrc} onClose={() => setPrintSrc(null)} />
      )}
    </section>
  );
}

function PathOpsRow({
  onSimplify,
  onReverse,
  onNeonize,
  pointCount,
  isClosed,
}: {
  onSimplify: (epsilonMM: number) => void;
  onReverse: () => void;
  onNeonize: (opts: { stitch: boolean }) => void;
  pointCount: number;
  isClosed: boolean;
}) {
  const [eps, setEps] = useState(0.5);
  // Tier 3 #27: stitch toggle for the Neonize op. When checked, the two
  // parallel offsets are joined via hairpin U-bends into one continuous
  // run rather than emitted as `<id>-outer` / `<id>-inner`. State lives
  // here (not lifted) because it's UI-local and doesn't need to survive
  // run reselects.
  const [stitchEnds, setStitchEnds] = useState(false);
  return (
    <div className="path-ops-row">
      <label className="diameter-picker">
        Simplify ε (mm)
        <input
          type="number"
          step="0.1"
          min="0"
          value={eps}
          onChange={(e) => setEps(Number(e.target.value))}
        />
      </label>
      <div className="path-ops-buttons">
        <button type="button" className="btn-secondary" onClick={() => onSimplify(eps)} title={`Run Douglas-Peucker on this run's polyline (${pointCount} pts) with ε = ${eps}mm. Higher ε = fewer vertices.`}>
          Simplify
        </button>
        <button type="button" className="btn-secondary" onClick={onReverse} title="Reverse this run's polyline order. Flips electrode anchors so they keep pointing at the same physical points.">
          Reverse
        </button>
        {/* Tier 3 #27: Neonize button + stitch toggle. The toggle sits
            next to the button (not in a separate popover) to keep the
            click-flow at one tap when defaults are fine. Open polylines
            now neonize as well (butt-capped parallel offsets). */}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => onNeonize({ stitch: stitchEnds })}
          title={
            isClosed
              ? 'Replace this run with parallel offset runs — the double-stroke / channel-letter pattern. Toggle "stitch" to emit one continuous tube via U-bends.'
              : 'Replace this open run with two butt-capped parallel offsets. Toggle "stitch" to emit one continuous tube via U-bends.'
          }
        >
          Neonize
        </button>
        <label
          className="meta neonize-stitch"
          title="Stitch the outer + inner offsets into one continuous run by inserting hairpin U-bends at the ends. Useful for fabrications that prefer one tube run with electrodes at the seam."
        >
          <input
            type="checkbox"
            checked={stitchEnds}
            onChange={(e) => setStitchEnds(e.target.checked)}
          />
          {' '}stitch ends
        </label>
      </div>
    </div>
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
