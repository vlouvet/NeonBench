import { Suspense, lazy, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  parseDoc,
  parseReport,
  RACEWAY_DEFAULT_DEPTH_MM,
  RACEWAY_DEFAULT_HEIGHT_MM,
  type DesignDoc,
  type DesignRun,
  type DesignVersion,
  type Project,
  type SegmentKind,
  type TubeSpec,
  type ValidationReport,
} from '../api';
import EditorCanvas, { type EditorTool } from '../components/EditorCanvas';
import ArrangePanel from '../components/ArrangePanel';
import ChannelLetterWizardDialog from '../components/ChannelLetterWizardDialog';
import HersheyTextDialog from '../components/HersheyTextDialog';
import HousingPickerModal from '../components/HousingPickerModal';
import { SectionHeader, CategoryIcon, type IconKind } from '../components/PanelSection';
import PrintHost from '../components/PrintHost';
import PrintPopover from '../components/PrintPopover';
import { describePrintPrefs, loadPrintPrefs, printPrefsToURLOpts, savePrintPrefs, type PrintPopoverValues } from '../lib/printPrefs';
import ValidationReportView, {
  type SeverityFilter,
} from '../components/ValidationReportView';
import { Eye } from '../components/icons/Eye';
import { Padlock } from '../components/icons/Padlock';
import { NEON_COLORS, colorHex } from '../lib/neonColors';
import { effectiveBends } from '../lib/bends';
import * as arrange from '../lib/arrange';
import * as ops from '../lib/docOps';
import { stepRepeat, stepRepeatPlan, type StepRepeatOptions } from '../lib/stepRepeat';
import * as guides from '../lib/guides';
import { hersheyRunsBBox, type HersheyRun } from '../lib/hershey/text';
import { formatFootageMM, normalizeUnits, type DisplayUnits } from '../lib/units';
import { FONTS, type FontKey } from '../lib/hershey/fonts';
import {
  isSessionEmpty,
  sessionRuns,
  type InlineTextSession,
} from '../lib/inlineTextState';
import { NumericField } from '../components/NumericField';
import type { HousingType, ElectrodeWithHousing } from '../lib/housingLibrary';
import { isArcKind } from '../lib/arcGeom';

// Tier 2 #99 — the OpenType dialog pulls in opentype.js, which is 250 kB
// of parser (73 kB gzipped) that most editing sessions never touch.
// `lazy()` puts it in its own chunk, fetched the first time the operator
// opens the dialog, so the editor's first paint pays nothing for it —
// the same trade App.tsx already makes for the three.js preview.
// Measured with vite 8: main chunk 576.18 kB -> 576.81 kB (+0.6 kB), plus a
// 250.83 kB / 73.16 kB-gzip OutlineTextDialog chunk. Imported eagerly it
// pushed the main chunk to 827.82 kB / 239.98 kB gzip instead.
const OutlineTextDialog = lazy(() => import('../components/OutlineTextDialog'));

export default function EditorPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [tubeSpec, setTubeSpec] = useState<TubeSpec | null>(null);
  const [allSpecs, setAllSpecs] = useState<TubeSpec[]>([]);
  const [specSwitching, setSpecSwitching] = useState(false);
  // Tier 1 #130 — in flight while the display unit PATCH is saving.
  const [unitsSwitching, setUnitsSwitching] = useState(false);
  // The project's display unit, coerced. Derived rather than mirrored in
  // state so it can never drift from the project the header is editing, and
  // defaulted through `normalizeUnits` so the pre-load render (project still
  // null) shows millimetres — the unit the doc is actually in — rather than
  // flashing inches at someone whose project is metric.
  const displayUnits: DisplayUnits = normalizeUnits(project?.units);
  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [tool, setToolRaw] = useState<EditorTool>('select');
  // Tier 2 #101 — inline canvas text. Size and face are toolbar state
  // (the canvas reads them when a caret opens); the string, the caret
  // and the kerning live in EditorCanvas for the length of one typing
  // session and reach the doc once, at commit.
  //
  // 100 mm matches the Add-text modal's default so the two entry points
  // produce the same size out of the box.
  const [textCapHeightMM, setTextCapHeightMM] = useState(100);
  const [textFontKey, setTextFontKey] = useState<FontKey>('rowmans');
  // The live caret, or null. It lives here rather than in EditorCanvas
  // because ending a session WRITES TO THE DOC, and the two things that
  // end one — leaving the tool, and clicking a toolbar button — are
  // this component's own events. Owning it there would mean committing
  // from an effect, which lints as an error and double-fires under
  // StrictMode's double render.
  const [textSession, setTextSession] = useState<InlineTextSession | null>(null);
  // Every bare-key shortcut THIS file binds — `o`, `c`, `j`, `k`, `[`,
  // `]`, Delete/Backspace, Escape — stands down while a caret is live,
  // and comes straight back when it closes.
  const textCaretActive = textSession !== null;
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
      // Tier 3 #33c — Cmd-A only selects runs the operator can see
      // and click. A hidden run wouldn't visibly land in the
      // selection (no ring on canvas), and a locked run shouldn't
      // pick up canvas-driven selection either. Ungrouped runs
      // (with no group_id) are always eligible. Pre-33b docs don't
      // have a `groups` array; that branch falls through cleanly to
      // "every run is eligible".
      const groupFlags = new Map<string, { visible: boolean; locked: boolean }>();
      for (const g of doc?.groups ?? []) {
        groupFlags.set(g.id, { visible: g.visible !== false, locked: !!g.locked });
      }
      const eligible = (doc?.runs ?? [])
        .filter((r) => {
          if (!r.group_id) return true;
          const f = groupFlags.get(r.group_id);
          if (!f) return true;
          return f.visible && !f.locked;
        })
        .map((r) => r.id);
      // No-op if the eligible set is already exactly the selection.
      if (eligible.length === prev.length && eligible.every((id) => prev.includes(id))) {
        return prev;
      }
      return eligible;
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
  // Tier 2 #91 — mm ruler gutters on the canvas. Default on: an operator
  // laying out a sign wants to know where 100 mm is without measuring.
  const [showRulers, setShowRulers] = useState(true);
  // Right-panel width (resizable via the left-edge drag handle), persisted
  // to localStorage and clamped to a sane range.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('nb.editorSidebarWidth'));
    return Number.isFinite(v) && v >= 280 && v <= 680 ? v : 340;
  });
  const sidebarResizeRef = useRef<{ startX: number; startW: number } | null>(null);
  // Collapsed per-run section keys (electrodes / blockouts / bends /
  // annotations). Component-local — the selected run changes often, so
  // persisting this would mostly surprise the operator.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set(),
  );
  // focusedElement — clicking an item name in a run-detail list pulses the
  // matching marker on the canvas. Transient: auto-clears after a beat so the
  // pulse reads as a "there it is" cue, not a sticky selection.
  const [focusedElement, setFocusedElement] = useState<{
    runId: string;
    kind: 'electrode' | 'blockout' | 'bend' | 'annotation';
    index: number;
  } | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  // Persist the sidebar width whenever it settles.
  useEffect(() => {
    localStorage.setItem('nb.editorSidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);
  const [hersheyOpen, setHersheyOpen] = useState(false);
  const [channelLetterOpen, setChannelLetterOpen] = useState(false);
  // Tier 2 #99 — OpenType outline text. Separate from `hersheyOpen`
  // on purpose: the two dialogs emit different KINDS of run (open
  // centreline vs closed outline) and must not be confusable.
  const [outlineTextOpen, setOutlineTextOpen] = useState(false);
  // Tier 3 #62 — housing-picker modal target. Non-null when the
  // operator right-clicked an electrode pin; carries enough context
  // (run id + electrode index within run.electrodes) for the modal
  // to read the existing housing fields off the doc and emit a
  // setElectrodeHousing op on Save.
  const [housingTarget, setHousingTarget] = useState<{
    runId: string;
    electrodeIndex: number;
  } | null>(null);
  // Tier 2 #72 — when the doc-wide auto-housing sweep is armed, this
  // opens a small modal that asks the operator to pick the housing
  // type (15/19/custom) to apply across every electrode. Reuses the
  // per-electrode HousingPickerModal so the picker UX is consistent.
  const [autoHousingOpen, setAutoHousingOpen] = useState(false);
  // Tier 2 #74 — which raceway guideline is selected, if any. Lives here
  // rather than in the canvas because the sidebar's split action is gated on
  // it; the canvas owns only the drag.
  const [selectedGuidelineId, setSelectedGuidelineId] = useState<string | null>(null);
  // Tier 2 #72 — transient status banner ("Added 24 doublebacks across
  // 12 runs"). Cleared by the next status set or by the auto-clear
  // timer below. Lives at the editor's `<p className="meta">` strip
  // so it sits in operator's eyeline above the canvas.
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!statusMessage) return;
    const t = setTimeout(() => setStatusMessage(null), 5000);
    return () => clearTimeout(t);
  }, [statusMessage]);
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
  // Tier 2 #93 — persisted per project so Quick plot repeats the last
  // job. Defaults, sanitizing and URL derivation live in lib/printPrefs.
  const [printOpts, setPrintOpts] = useState<PrintPopoverValues>(() =>
    loadPrintPrefs(projectId),
  );
  useEffect(() => {
    savePrintPrefs(projectId, printOpts);
  }, [projectId, printOpts]);
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
    // Tier 2 #101 — leaving the text tool COMMITS whatever is in the
    // caret. Every other route out of a session (Esc, a click on the
    // canvas, a click on any control outside it) commits too; there is
    // deliberately no gesture that throws typed text away.
    if (next !== 'text' && textSession) endTextSession(null);
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

  // applyOp runs a doc op, hands editDoc the finished result, and returns that
  // result synchronously so the caller can build a toast from it.
  //
  // The subtlety it exists to remove: editDoc updates through
  // `setDoc(prev => …)`, and React runs that updater during the re-render, not
  // inside the click handler. So the long-standing idiom here —
  //
  //     let result = null;
  //     editDoc(prev => { const r = op(prev); result = r; return r.doc; });
  //     if (!result) return;              // <- usually taken
  //
  // reads `result` while it is still null and bails before ever showing the
  // message. It LOOKS like it works because React eagerly evaluates the first
  // updater queued on an otherwise-idle hook, so the toast appears on a fresh
  // page and silently stops once anything else is pending. Computing against
  // the doc React last rendered removes the timing question entirely; the
  // `prev === rendered` guard keeps the update correct if state did move.
  function applyOp<R extends { doc: DesignDoc }>(
    compute: (d: DesignDoc) => R,
  ): R | null {
    if (!doc) return null;
    const rendered = doc;
    const result = compute(rendered);
    editDoc((prev) => (prev === rendered ? result.doc : compute(prev).doc));
    return result;
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
      // Tier 2 #101 — a live text caret owns every unmodified key.
      // Without this, typing "open channel" toggles Break/Move Opening
      // on the 'o' and Connect Tubes on the 'c', mid-word. Cmd/Ctrl
      // combinations are deliberately still live, so undo and redo keep
      // working while typing.
      if (textCaretActive && !meta) return;
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
    // `setTool` is deliberately not a dependency. It now closes over the
    // text session (leaving the text tool commits it), so listing it
    // would re-bind this window listener on every render — and the
    // staleness it would guard against is unreachable: the only calls
    // to `setTool` in here are the 'o' and 'c' hotkeys, which return
    // above whenever a caret is live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, textCaretActive]);

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
    // project.tube_spec_id is a dependency because a spec switch changes the
    // rules the doc is judged against without changing the doc itself; without
    // it this effect cannot re-fire to correct a stale report.
  }, [doc, dirty, projectId, project?.tube_spec_id]);

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
      // Tier 2 #101 — see the tool-hotkey handler above. Escape must
      // reach the caret (where it COMMITS the text) rather than clear
      // the run selection, and Delete/Backspace must edit the string
      // rather than delete the selected runs.
      if (textCaretActive) return;
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
  }, [joinArm, selectedRunIds, doc, textCaretActive]);

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

  // Tier 2 #75 — how many runs exceed the spec's max segment length, which
  // gates the auto-split button. Gated on the doc rather than on the
  // validation report: the report is debounced 500ms behind every edit, so
  // report-gating leaves the button stale in both directions — disabled just
  // after the operator draws an overlong tube, enabled for a beat after they
  // fix one. This measures with the same function the op uses, so an enabled
  // button always has something to do. Hoisted above the early returns for
  // the same reason as hasLegacyRunIds.
  const maxSegmentLengthMM = tubeSpec?.max_segment_length_mm ?? 0;
  const overlongRunCount = useMemo(() => {
    if (!doc || !(maxSegmentLengthMM > 0)) return 0;
    return doc.runs.filter((r) => ops.runLengthMM(r) > maxSegmentLengthMM).length;
  }, [doc, maxSegmentLengthMM]);

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
      // Tier 2 #101 — 'j' and 'k' are letters first while a caret is
      // live; jumping the viewport to the next validation issue in the
      // middle of a word is the same class of ambush as switching tools.
      if (textCaretActive) return;
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
  }, [visibleIssueIndices, selectedIssueIndex, doc, report, textCaretActive]);

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

  function placeAnnotation(
    runId: string,
    kind: 'jump' | 'support' | 'doubleback' | 'drop_bend',
    liveIndex: number,
  ) {
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

  // Drag-to-resize handles (feat-editor-scale-handles). The canvas scales
  // every selected run about a shared anchor from a drag snapshot and hands
  // back the absolute new points for each run; we replace them in one editDoc
  // so the live drag coalesces to a single undo step.
  function scaleRuns(updates: { runId: string; points: [number, number][] }[]) {
    editDoc((prev) => ops.setRunsPoints(prev, updates));
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

  // Tier 2 #72 — bulk doubleback every open-run electrode termination.
  // The wrapped op (insertDoubleback) and its per-pin sidebar tool are
  // unchanged; this just sweeps every applicable target on the doc and
  // accumulates the result so editDoc collapses it into one undo step.
  // Skips terminations that already have a hairpin within ~tubeDiameter
  // of the endpoint (re-running on a fully-doublebacked doc is a no-op).
  function autoDoublebackAll() {
    if (!doc) return;
    const result = applyOp((prev) => ops.autoDoublebackAllTerminations(prev));
    if (!result) return;
    // Toast: report added vs skipped so re-running on an already-
    // doublebacked doc is clearly a no-op (added=0, skipped=N).
    const r: ops.AutoDoublebackResult = result;
    if (r.added === 0 && r.skipped === 0) {
      setStatusMessage('No open-run terminations to doubleback.');
    } else if (r.added === 0) {
      setStatusMessage(
        `0 doublebacks added (${r.skipped} terminations already had one).`,
      );
    } else {
      const runsAffected = new Set<string>();
      for (const run of r.doc.runs) {
        // A run was affected if its polyline length differs from the
        // pre-batch doc. Counting via the result doc is approximate but
        // good enough for the toast.
        const before = doc.runs.find((x) => x.id === run.id);
        if (
          before &&
          before.polyline.points.length !== run.polyline.points.length
        ) {
          runsAffected.add(run.id);
        }
      }
      const skipMsg = r.skipped > 0 ? ` · ${r.skipped} skipped (already doublebacked)` : '';
      setStatusMessage(
        `Added ${r.added} doublebacks across ${runsAffected.size} runs${skipMsg}.`,
      );
    }
  }

  // Tier 2 #75 — cut every run over the spec's max segment length into the
  // fewest equal pieces that fit under it. The validator already flags these
  // as errors; before this the only remedy was to walk each warning and
  // splitRun by hand, which on a serpentine means eyeballing where 1/3 of the
  // arc length falls.
  function autoSplitOverlong() {
    if (!doc) return;
    if (!(maxSegmentLengthMM > 0)) return;
    const result = applyOp((prev) => ops.autoSplitOverlongTubes(prev, maxSegmentLengthMM));
    if (!result) return;
    const r: ops.AutoSplitResult = result;
    const parts: string[] = [];
    if (r.runsSplit > 0) {
      parts.push(
        `Split ${r.runsSplit} ${r.runsSplit === 1 ? 'run' : 'runs'} into ${r.piecesCreated} pieces`,
      );
    }
    // Name the skip explicitly. A silent "0 runs split" on a doc that visibly
    // has an overlong loop would read as the button being broken.
    if (r.skippedClosedWithElectrodes > 0) {
      parts.push(
        `${r.skippedClosedWithElectrodes} closed ${r.skippedClosedWithElectrodes === 1 ? 'run' : 'runs'} skipped (break the loop open first)`,
      );
    }
    setStatusMessage(
      parts.length > 0 ? `${parts.join(' · ')}.` : 'No runs exceed the max segment length.',
    );
  }

  // Tier 3 #78 — curve or straighten one segment. The vertex list does not
  // change, so nothing anchored by index moves.
  function setSegmentType(runId: string, segmentIndex: number, type: SegmentKind) {
    editDoc((prev) => ops.setSegmentType(prev, runId, segmentIndex, type));
    setSelectedToOne(runId);
    setStatusMessage(
      isArcKind(type)
        ? 'Segment converted to an arc — validation re-runs against the curve, not the chord.'
        : 'Segment straightened.',
    );
  }

  // Tier 3 #87 — move an arc's bow to the other side of its chord. The op
  // reads the current side out of the doc it is handed, so the flip cannot go
  // stale between the click and the state update; nothing here needs to know
  // which side it is on.
  function flipSegmentArc(runId: string, segmentIndex: number) {
    editDoc((prev) => ops.flipSegmentArc(prev, runId, segmentIndex));
    setSelectedToOne(runId);
    setStatusMessage('Arc flipped — same endpoints, same length, bow on the other side.');
  }

  // Tier 2 #74 — raceway guideline handlers. Adding drops the line at the
  // vertical centre of the design bbox, which is where a raceway usually
  // wants to be on a single-row sign and is in any case one drag from
  // anywhere else.
  //
  // Tier 2 #104 — adding the line OFFERS to model the box that hangs off it.
  // Both mutations go through ONE editDoc so the pair is a single undo step:
  // a guideline whose box arrived on a separate step would undo into a doc
  // the backend rejects (a Raceway with no guideline is invalid).
  function addRacewayGuideline() {
    if (!doc) return;
    const [, y, , h] = doc.view_box_mm;
    const yMM = y + h / 2;
    const newId = ops.nextGuidelineId(doc);
    const alsoModel = window.confirm(
      `Raceway guideline ${newId} added.\n\n` +
        'Also model the raceway box — the aluminium enclosure the letters mount to and ' +
        'the transformers live in? It gets its own dimensioned page in the print PDF.\n\n' +
        'You can add or remove it later from the sidebar.',
    );
    editDoc((prev) => {
      const withGuide = ops.addRacewayGuideline(prev, yMM);
      return alsoModel ? ops.createRaceway(withGuide, newId) : withGuide;
    });
    setSelectedGuidelineId(newId);
    setStatusMessage(
      alsoModel
        ? `Raceway ${newId} added with its box — drag the line into position, then Fit to runs.`
        : 'Raceway guideline added — drag it into position.',
    );
  }

  // Tier 2 #91 — one mover for both kinds. `guides.moveGuide` reads the
  // axis off the guide itself, so `posMM` is y for a horizontal guide and x
  // for a vertical one and no caller has to know which.
  function moveGuideline(id: string, posMM: number) {
    editDoc((prev) => guides.moveGuide(prev, id, posMM));
  }

  // Tier 2 #91 — a construction guide dragged off a canvas ruler. Selected
  // on creation so Delete removes the one just placed.
  function addConstructionGuide(axis: 'h' | 'v', posMM: number) {
    if (!doc) return;
    const newId = ops.nextGuidelineId(doc);
    editDoc((prev) => guides.addConstructionGuide(prev, axis, posMM));
    setSelectedGuidelineId(newId);
    setStatusMessage(
      `Construction guide ${newId} added at ${axis === 'v' ? 'x' : 'y'}=${posMM.toFixed(1)}mm — layout only, never printed.`,
    );
  }

  function deleteRacewayGuideline(id: string) {
    const wasRaceway = !!doc && guides.isRacewayGuideline(guides.findGuide(doc, id));
    editDoc((prev) => ops.removeGuideline(prev, id));
    setSelectedGuidelineId((cur) => (cur === id ? null : cur));
    // Say what deleting does NOT do. Runs already cut keep their geometry and
    // their raceway tag, and an operator who expected the line to "undo"
    // itself should find that out from the toast, not from the PDF. A
    // construction guide never cut anything, so that warning would only be
    // noise there.
    setStatusMessage(
      wasRaceway
        ? 'Guideline removed. Tubes already split stay split and keep their raceway.'
        : 'Construction guide removed.',
    );
  }

  // Tier 2 #91 — the selected guideline, but only if it is a raceway. The
  // button below is disabled off this, and `splitTubesAtRaceway` re-checks:
  // a construction guide reaching the split path would cut real glass on a
  // line the operator drew as scaffolding.
  const racewaySelected =
    !!selectedGuidelineId &&
    !!doc &&
    guides.isRacewayGuideline(guides.findGuide(doc, selectedGuidelineId));

  function splitTubesAtRaceway() {
    if (!doc || !selectedGuidelineId || !racewaySelected) return;
    const result = applyOp((prev) => ops.splitTubesAtRaceway(prev, selectedGuidelineId));
    if (!result) return;
    const r: ops.SplitAtRacewayResult = result;
    const parts: string[] = [];
    if (r.runsSplit > 0) {
      parts.push(
        `Split ${r.runsSplit} ${r.runsSplit === 1 ? 'tube' : 'tubes'} into ${r.piecesCreated} pieces on ${selectedGuidelineId}`,
      );
    }
    if (r.skippedClosedWithElectrodes > 0) {
      parts.push(
        `${r.skippedClosedWithElectrodes} closed ${r.skippedClosedWithElectrodes === 1 ? 'run' : 'runs'} skipped (clear their electrodes first)`,
      );
    }
    setStatusMessage(
      parts.length > 0 ? `${parts.join(' · ')}.` : 'No tubes cross this guideline.',
    );
  }

  // -------------------------------------------------------------------------
  // Tier 2 #104 / NW #133 — the modelled raceway box
  // -------------------------------------------------------------------------
  //
  // Everything here is keyed by the GUIDELINE's id, because the box shares it.
  // `selectedRaceway` is therefore just "does the selected guideline have a
  // box", and there is no second selection model to keep in sync.
  const selectedRaceway =
    doc && selectedGuidelineId ? ops.findRaceway(doc, selectedGuidelineId) : undefined;
  const selectedRacewayMembers =
    doc && selectedGuidelineId ? ops.racewayMemberIds(doc, selectedGuidelineId).length : 0;

  function createRacewayBox() {
    if (!doc || !selectedGuidelineId || !racewaySelected) return;
    editDoc((prev) => ops.createRaceway(prev, selectedGuidelineId));
    setStatusMessage(
      `Raceway box ${selectedGuidelineId} modelled — 8in x 8in default, drag its ends or type exact numbers.`,
    );
  }

  function fitRacewayToRuns() {
    if (!doc || !selectedGuidelineId) return;
    const members = ops.racewayMemberIds(doc, selectedGuidelineId).length;
    if (members === 0) {
      setStatusMessage(
        `No runs carry raceway ${selectedGuidelineId} yet — split tubes at the guideline, or label runs with its id, then fit.`,
      );
      return;
    }
    editDoc((prev) => ops.fitRacewayToRuns(prev, selectedGuidelineId));
    setStatusMessage(
      `Raceway ${selectedGuidelineId} fitted to ${members} ${members === 1 ? 'run' : 'runs'} — ends flush with the outermost glass.`,
    );
  }

  function setRacewayGeometry(
    field: 'x_mm' | 'length_mm' | 'height_mm' | 'depth_mm',
    value: number,
  ) {
    if (!doc || !selectedGuidelineId) return;
    editDoc((prev) => ops.setRacewayGeometry(prev, selectedGuidelineId, { [field]: value }));
  }

  function dragRacewayEnd(id: string, end: 'left' | 'right', xMM: number) {
    editDoc((prev) => ops.dragRacewayEnd(prev, id, end, xMM));
  }

  function removeRacewayBox() {
    if (!doc || !selectedGuidelineId) return;
    editDoc((prev) => ops.removeRaceway(prev, selectedGuidelineId));
    setStatusMessage(
      'Raceway box removed. The guideline and every raceway tag stay — un-modelling the hardware does not un-cut the glass.',
    );
  }

  // Tier 2 #72 — bulk-set a housing on every electrode that doesn't
  // already have one. Opens the housing picker modal; on Save the
  // picked type is applied across the doc in one editDoc, collapsing
  // to a single undo step. Electrodes that already carry a housing
  // are skipped (preserves per-pin custom edits the operator may
  // have already made).
  function openAutoHousingPicker() {
    if (!doc) return;
    setAutoHousingOpen(true);
  }
  function applyAutoHousing(housing: ops.HousingInput) {
    if (!doc) return;
    try {
      const result = applyOp((prev) => ops.autoHousingAllElectrodes(prev, housing));
      setAutoHousingOpen(false);
      if (!result) return;
      const r: ops.AutoHousingResult = result;
      if (r.applied === 0 && r.skipped === 0) {
        setStatusMessage('No electrodes to house.');
      } else if (r.applied === 0) {
        setStatusMessage(
          `0 housings added (${r.skipped} electrodes already had one).`,
        );
      } else {
        const skipMsg = r.skipped > 0
          ? ` · ${r.skipped} skipped (already housed)`
          : '';
        setStatusMessage(
          `Added housings to ${r.applied} electrodes${skipMsg}.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  // Tier 3 #33c — Layers panel helpers. The visibility toggle also
  // drops any of the group's runs out of the current selection
  // (hidden runs can't visibly stay selected — there's no ring on
  // canvas for a hidden run, so the operator would have a phantom
  // multi-op target). The lock toggle leaves the selection alone
  // (lock is click-protect, not display-protect, so a previously-
  // selected locked run is still meaningfully editable via the
  // sidebar's color/diameter/Delete affordances).
  function toggleGroupVisible(groupId: string) {
    if (!doc) return;
    const group = (doc.groups ?? []).find((g) => g.id === groupId);
    if (!group) return;
    const wasVisible = group.visible !== false;
    editDoc((prev) => ops.setGroupVisible(prev, groupId, !wasVisible));
    if (wasVisible) {
      // Hiding: drop members from the current selection.
      setSelectedRunIds((prev) => {
        const memberIds = new Set(
          (doc.runs ?? [])
            .filter((r) => r.group_id === groupId)
            .map((r) => r.id),
        );
        const filtered = prev.filter((id) => !memberIds.has(id));
        return filtered.length === prev.length ? prev : filtered;
      });
    }
  }

  function toggleGroupLocked(groupId: string) {
    if (!doc) return;
    const group = (doc.groups ?? []).find((g) => g.id === groupId);
    if (!group) return;
    editDoc((prev) => ops.setGroupLocked(prev, groupId, !group.locked));
    // Selection unchanged — lock is a click-protect, not a
    // display-protect. A locked-but-selected run still lets the
    // operator do everything the sidebar offers (color, diameter,
    // delete), just not pick it via canvas clicks.
  }

  // Click on a Layers row body picks every run in the group. Bypasses
  // the lock on purpose — the sidebar is the deliberate escape hatch
  // so the operator can edit a locked layer's runs through explicit
  // selection. Hidden groups still select-on-click (the operator may
  // be about to un-hide and operate on them).
  function selectGroupMembers(groupId: string) {
    if (!doc) return;
    const memberIds = (doc.runs ?? [])
      .filter((r) => r.group_id === groupId)
      .map((r) => r.id);
    if (memberIds.length === 0) return;
    setSelectedRunIds(memberIds);
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

  // Tier 2 #90 — arrange ops. Each is one applyOp call, so the whole
  // arrangement lands as a single doc swap and a single undo entry rather
  // than one per run. The ops themselves return the SAME doc object when
  // there is nothing to do, which editDoc's `next === prev` guard turns into
  // "no history entry, no dirty flag" for free — that's why a disabled-looking
  // click on an already-aligned selection doesn't burn an undo step.
  //
  // The selection is deliberately left alone by all four: the operator's next
  // move after aligning is usually to align on the other axis.
  function alignSelected(edge: arrange.AlignEdge) {
    applyOp((prev) => ({ doc: arrange.alignRuns(prev, selectedRunIds, edge) }));
  }

  function distributeSelected(axis: arrange.Axis) {
    applyOp((prev) => ({ doc: arrange.distributeRuns(prev, selectedRunIds, axis) }));
  }

  function mirrorSelected(axis: arrange.Axis) {
    applyOp((prev) => ({ doc: arrange.mirrorRuns(prev, selectedRunIds, axis) }));
  }

  function reorderSelected(move: arrange.DepthMove) {
    applyOp((prev) => ({ doc: arrange.reorderRuns(prev, selectedRunIds, move) }));
  }

  // Tier 3 #103 — step and repeat. One applyOp, so a 4 x 3 array is a single
  // undo step rather than eleven.
  //
  // The plan is recomputed here against the RENDERED doc purely to word the
  // toast; `applyOp` computes the doc from the same value, so the number in
  // the message and the number of runs added cannot disagree. The op itself
  // re-plans internally, which is what keeps it safe as a pure export.
  //
  // The selection is deliberately left on the ORIGINAL runs, matching the
  // other four arrange ops: the usual next move is to array again on the
  // other axis, and re-selecting the source by hand each time is worse than
  // clicking the new copies when you actually want them.
  function stepRepeatSelected(opts: StepRepeatOptions) {
    if (!doc) return;
    const plan = stepRepeatPlan(doc, selectedRunIds, opts);
    if (plan.error) {
      setStatusMessage(plan.error);
      return;
    }
    applyOp((prev) => ({ doc: stepRepeat(prev, selectedRunIds, opts) }));
    setStatusMessage(
      `Arrayed ${plan.runIds.length} run${plan.runIds.length === 1 ? '' : 's'} ` +
        `into a ${plan.countX} × ${plan.countY} grid — added ${plan.newRuns} run` +
        `${plan.newRuns === 1 ? '' : 's'}. Copies keep their channel-letter settings; ` +
        `they do not inherit the raceway.`,
    );
  }

  // Tier 2 #98 — merge overlapping closed outlines into one (NW calls the
  // effect "Weld"; `weld` is taken here by the physical glass weld the
  // validator spaces electrodes against, so nothing user-facing says it).
  //
  // The polygon-clipping library is fetched on the first click, the way
  // PR #158 fetches opentype.js: `import()` puts booleanOps and martinez in
  // their own chunk, so a session that never merges anything never pays for
  // them. That is also why the button's disabled state is computed from
  // `closedSelectedCount` above rather than by asking the module.
  //
  // The toast is the only place the operator learns what the op traded away
  // — flattened curves, dropped electrodes — so it says all of it rather
  // than "Merged.".
  async function mergeOutlinesSelected() {
    if (!doc) return;
    const ids = selectedRunIds.slice();
    const { unionOutlinesPlan, unionRuns } = await import('../lib/booleanOps');
    const plan = unionOutlinesPlan(doc, ids);
    if (plan.error) {
      setStatusMessage(plan.error);
      return;
    }
    const result = applyOp((prev) => unionRuns(prev, ids));
    if (!result) return;
    const newIds = result.doc.runs
      .filter((r) => !doc.runs.some((old) => old.id === r.id))
      .map((r) => r.id);
    setSelectedRunIds(newIds);

    const bits: string[] = [
      `Merged ${plan.runIds.length} outlines into ${plan.outerCount} boundar` +
        `${plan.outerCount === 1 ? 'y' : 'ies'}` +
        (plan.holeCount > 0
          ? ` and ${plan.holeCount} hole${plan.holeCount === 1 ? '' : 's'} (each its own closed run)`
          : ''),
    ];
    if (plan.flattenedInputs > 0) {
      bits.push(
        `${plan.flattenedInputs} arc run${plan.flattenedInputs === 1 ? ' was' : 's were'} ` +
          'FLATTENED to line segments — a union boundary has no arc form, so the result carries ' +
          'no curve data. Undo if you need the curves.',
      );
    }
    const dropped: string[] = [];
    if (plan.droppedElectrodes) dropped.push(`${plan.droppedElectrodes} electrode(s)`);
    if (plan.droppedBlockouts) dropped.push(`${plan.droppedBlockouts} blockout(s)`);
    if (plan.droppedAnnotations) dropped.push(`${plan.droppedAnnotations} annotation(s)`);
    if (plan.droppedBends) dropped.push(`${plan.droppedBends} bend(s)`);
    if (plan.droppedDirections) dropped.push(`${plan.droppedDirections} flow direction(s)`);
    if (dropped.length > 0) {
      bits.push(
        `Dropped ${dropped.join(', ')} — they address vertices the merge dissolved, and a ` +
          'remapped index would point at the wrong glass.',
      );
    }
    bits.push(...plan.warnings);
    setStatusMessage(bits.join(' '));
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
      // Bug #02: seed the per-run diameter from the project tube spec so the
      // run reports a real size (e.g. "ø 12mm") instead of "ø ?mm". Unset
      // (undefined) when no spec is loaded yet, which still inherits the
      // project default. The per-run editor can override or clear it.
      tube_diameter_mm: tubeSpec?.diameter_mm,
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
      // Bug #02: seed diameter from the project tube spec (same as the
      // drawing tools) so inserted text runs report a real size, not "ø ?mm".
      tube_diameter_mm: tubeSpec?.diameter_mm,
    }));
    editDoc((prev) => ops.appendRuns(prev, designRuns, 'text'));
    setHersheyOpen(false);
  }

  // Tier 2 #101 — commit one inline-text session. Unlike the modal's
  // insert this does NOT re-centre the runs: the operator clicked where
  // the baseline goes and watched the glyphs appear there, so moving
  // them on commit would be the preview disagreeing with the result.
  //
  // ONE applyOp for the whole session, whatever was typed into it —
  // that is what makes a single undo take back the whole word. Routed
  // through applyOp rather than a bare editDoc whose return value we
  // read, per CLAUDE.md's stale-result bug class.
  // End the live caret: commit its strokes (if any), then open `next`
  // in its place — `null` for "no caret any more", or a fresh session
  // when the operator clicked somewhere else on the canvas to keep
  // typing. Both setStates land in the same React batch, so the caret
  // never blinks out between the two.
  function endTextSession(next: InlineTextSession | null) {
    if (textSession && !isSessionEmpty(textSession)) {
      commitInlineText(sessionRuns(textSession));
    }
    setTextSession(next);
  }

  function commitInlineText(runs: HersheyRun[]) {
    if (!doc || runs.length === 0) return;
    const designRuns = runs.map<DesignRun>((r) => ({
      id: 'text', // appendRuns rewrites with a unique `text-N` id
      polyline: {
        points: r.points.map(([x, y]) => [x, y] as [number, number]),
        closed: false,
      },
      // Bug #02, same as the modal: seed the diameter from the project
      // tube spec so the new runs report a real size, not "ø ?mm".
      tube_diameter_mm: tubeSpec?.diameter_mm,
    }));
    applyOp((prev) => ({ doc: ops.appendRuns(prev, designRuns, 'text') }));
  }

  // Insert the Channel Letter Wizard's runs (Tier 2 #71). The wizard
  // emits them centered on (0,0); we translate so their bbox center
  // lands on the current view-box center, exactly the same pattern as
  // insertHersheyText. Goes through editDoc → insertChannelLetterRuns
  // so it's a single undo step regardless of how many letters fired.
  function insertChannelLetterWizardOutput(runs: DesignRun[]) {
    if (!doc || runs.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of runs) {
      for (const [x, y] of r.polyline.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const [vx, vy, vw, vh] = doc.view_box_mm;
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    const dx = Number.isFinite(minX) ? cx - (minX + maxX) / 2 : 0;
    const dy = Number.isFinite(minY) ? cy - (minY + maxY) / 2 : 0;
    const translated = runs.map<DesignRun>((r) => ({
      ...r,
      polyline: {
        ...r.polyline,
        points: r.polyline.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
      },
    }));
    editDoc((prev) => ops.insertChannelLetterRuns(prev, translated));
    setChannelLetterOpen(false);
  }

  // Insert OpenType outline text (Tier 2 #99). Same centring pattern as
  // the two dialogs above, but the runs are CLOSED contours rather than
  // open centrelines: they are the boundary of the ink, and the operator
  // turns them into tubes afterwards with Neonize or the channel-letter
  // face flag. The dialog says so; this handler must not quietly convert
  // them into anything else.
  function insertOutlineText(runs: DesignRun[]) {
    if (!doc || runs.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of runs) {
      for (const [x, y] of r.polyline.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const [vx, vy, vw, vh] = doc.view_box_mm;
    const cx = vx + vw / 2;
    const cy = vy + vh / 2;
    const dx = Number.isFinite(minX) ? cx - (minX + maxX) / 2 : 0;
    const dy = Number.isFinite(minY) ? cy - (minY + maxY) / 2 : 0;
    const translated = runs.map<DesignRun>((r) => ({
      ...r,
      // Bug #02: seed diameter from the project tube spec so an inserted
      // run reports a real size instead of "ø ?mm".
      tube_diameter_mm: r.tube_diameter_mm ?? tubeSpec?.diameter_mm,
      polyline: {
        ...r.polyline,
        points: r.polyline.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
      },
    }));
    editDoc((prev) => ops.appendRuns(prev, translated, 'otf'));
    setOutlineTextOpen(false);
  }

  // Switching the project's tube spec from inside the editor needs to do
  // two things atomically from the user's perspective: persist the new
  // tube_spec_id, then re-run validation against the *new* spec so the
  // displayed errors/warnings stop reflecting the old bend-radius/spacing
  // limits. Without the revalidate the user would silently see a stale
  // (and possibly falsely-green) report. The dropdown is disabled while
  // either request is in flight to avoid double-fires.
  // Tier 1 #130 — switch the project's DISPLAY unit. Unlike changeTubeSpec
  // this touches no geometry and triggers no revalidation: `units` is a
  // display preference, the doc stays millimetres, and the validator has
  // never read it. That is the whole reason this is a one-line PATCH and the
  // spec switch is forty lines.
  async function changeDisplayUnits(next: DisplayUnits) {
    if (unitsSwitching) return;
    if (!project || next === normalizeUnits(project.units)) return;
    setUnitsSwitching(true);
    setError(null);
    try {
      setProject(await api.updateProject(projectId, { units: next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnitsSwitching(false);
    }
  }

  async function changeTubeSpec(nextSpecId: number) {
    if (specSwitching) return;
    if (!project || nextSpecId === project.tube_spec_id) return;
    setSpecSwitching(true);
    setError(null);
    try {
      const prevDiameterMM = tubeSpec?.diameter_mm;
      const updatedProject = await api.updateProject(projectId, { tube_spec_id: nextSpecId });
      setProject(updatedProject);
      setTubeSpec(allSpecs.find((s) => s.id === updatedProject.tube_spec_id) ?? null);

      // Runs seeded from the old spec must follow the project rather than pin
      // the old diameter. tube_diameter_mm is not cosmetic: it feeds bend
      // clustering, the takeoff's glass grouping and the ø printed on the
      // pattern, so a stale value orders the wrong stock and tells the bender
      // the wrong size. Deliberate overrides to some *other* diameter survive.
      let nextDoc = doc;
      if (doc && prevDiameterMM != null) {
        const rebased = ops.clearRunDiametersMatching(doc, prevDiameterMM);
        if (rebased !== doc) {
          nextDoc = rebased;
          editDoc(() => rebased); // undoable, and marks the doc dirty
        }
      }

      // With unsaved edits the SAVED version is a different document, so
      // revalidating it reports on runs the operator cannot see — that is how
      // this showed "All rules pass · 0 runs" over a canvas full of errors.
      // Validate what is actually on screen instead. Clearing diameters above
      // also makes the doc diverge from the saved version, hence `!== doc`.
      if ((dirty || nextDoc !== doc) && nextDoc) {
        setReport(await api.validateDoc(projectId, nextDoc));
      } else {
        const revalidated = await api.revalidate(projectId, versionId);
        setVersion(revalidated);
        setReport(parseReport(revalidated));
      }
    } catch (e) {
      setError(`change tube spec: ${(e as Error).message}`);
    } finally {
      setSpecSwitching(false);
    }
  }

  function beginSidebarResize(e: ReactPointerEvent) {
    sidebarResizeRef.current = { startX: e.clientX, startW: sidebarWidth };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture can throw in test/jsdom — ignore */
    }
    e.preventDefault();
  }
  function onSidebarResizeMove(e: ReactPointerEvent) {
    const st = sidebarResizeRef.current;
    if (!st) return;
    // Handle is on the panel's LEFT edge, so dragging left (clientX down)
    // widens the panel.
    const next = Math.min(680, Math.max(280, st.startW - (e.clientX - st.startX)));
    setSidebarWidth(next);
  }
  function endSidebarResize(e: ReactPointerEvent) {
    if (!sidebarResizeRef.current) return;
    sidebarResizeRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function toggleSection(key: string) {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Pulse a run-detail item's marker on the canvas. Auto-clears after a beat.
  function focusElementOnCanvas(
    runId: string,
    kind: 'electrode' | 'blockout' | 'bend' | 'annotation',
    index: number,
  ) {
    setFocusedElement({ runId, kind, index });
    if (focusTimerRef.current) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => setFocusedElement(null), 2600);
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
  // Tier 2 #98 — gate for "Merge outlines". Counted here rather than asked of
  // `booleanOps` so the button costs nothing: importing that module to answer
  // a disabled-state question would pull the polygon-clipping library into
  // the main bundle and undo the whole point of loading it on demand.
  const closedSelectedCount = doc.runs.filter(
    (r) => selectedRunIds.includes(r.id) && r.polyline.closed,
  ).length;

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
              className={tool === 'drop_bend' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('drop_bend')}
              title="Mark a drop bend (tube briefly dips behind the substrate; emits a DROP entry in the bend list, a subtle dip in 3D preview)"
            >Mark drop</button>
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
              className={tool === 'text' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('text')}
              title="Type text directly on the canvas: click to place the caret, then type. Alt+←/→ kerns the pair at the caret. Esc or a click elsewhere commits."
            >Text</button>
            {tool === 'text' && (
              // Size and face for the next (and current) caret. Shown
              // only with the tool active so the toolbar doesn't grow
              // two permanent controls that mean nothing the rest of
              // the time.
              <>
                <label className="meta" title="Cap height — the literal height of a capital, in mm">
                  {' '}size{' '}
                  <NumericField
                    // NOT a raw <input type="number">: a numeric `step`
                    // makes `min` a lattice base and an off-lattice
                    // value silently swallows form submits. This is a
                    // millimetre measurement in an imperial trade —
                    // 12.7, 19.05 and 25.4 all have to be typeable.
                    // (Tier 3 #112 took this file off the lint rule's
                    // legacy exempt list, so the rule now catches it
                    // here rather than relying on discipline.)
                    value={textCapHeightMM}
                    min={1}
                    onChange={(e) => {
                      const v = Number(e.currentTarget.value);
                      if (Number.isFinite(v) && v > 0) setTextCapHeightMM(v);
                    }}
                    style={{ width: '5rem' }}
                    aria-label="Inline text cap height (mm)"
                  />
                  {' mm'}
                </label>
                <select
                  value={textFontKey}
                  onChange={(e) => setTextFontKey(e.currentTarget.value as FontKey)}
                  aria-label="Inline text font"
                  title="Single-stroke face for inline text"
                >
                  {Object.values(FONTS).map((f) => (
                    <option key={f.key} value={f.key}>{f.displayName}</option>
                  ))}
                </select>
              </>
            )}
            <button
              type="button"
              className="tool-btn"
              onClick={() => setHersheyOpen(true)}
              title="Insert Hershey single-stroke text as new tube runs (modal: transforms, per-pair kerning handles, multi-line)"
            >Add text…</button>
            <button
              type="button"
              className="tool-btn"
              onClick={() => setOutlineTextOpen(true)}
              title="Set text in a customer-supplied OpenType/TrueType font as closed OUTLINES (not tube centrelines) — then Neonize or use as channel-letter faces"
            >Outline text</button>
            <button
              type="button"
              className="tool-btn"
              onClick={() => setChannelLetterOpen(true)}
              title="Generate a complete channel-letter pattern from text (face outlines + parallel tubes, raceway-split optional)"
            >Channel letter wizard</button>
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
            {/* Tier 3 #112 — was `step="0.5" min="0.1"`, which made the
                valid set 0.1, 0.6, 1.1, … : a 1mm snap grid was off the
                lattice. `min` is kept as a plain lower bound; the arrow
                keys now step by the browser default of 1 instead of 0.5,
                which is the documented cost of the rule. */}
            <NumericField
              min="0.1"
              value={snapMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v > 0) setSnapMM(v);
              }}
              className="snap-input"
              title="Snap grid spacing in mm"
            />
            {/* Tier 2 #91 — rulers & guides. Sits next to Snap because guide
                snapping rides the same snap-enabled toggle. */}
            <button
              type="button"
              className={showRulers ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setShowRulers((v) => !v)}
              title="Show mm rulers along the canvas top and left edge. Drag off a ruler to pull out a construction guide; guides are layout-only and never printed. Tier 2 #91."
            >Rulers {showRulers ? 'on' : 'off'}</button>
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
                  // The popover stores `frontFacing` (the affirmative
                  // form of the opt-out checkbox). printPDFURL accepts
                  // `mirror` directly — when frontFacing is checked the
                  // user wants the un-mirrored print (mirror=false);
                  // unchecked yields the trade-default mirrored print
                  // (omit the mirror param entirely). Tier 2 #73.
                  setPrintSrc(
                    api.printPDFURL(
                      projectId,
                      versionId,
                      printPrefsToURLOpts(printOpts),
                    ),
                  );
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
              <button
                type="button"
                className="tool-btn"
                onClick={() => {
                  if (dirty) return;
                  // Read storage at click time, so settings changed in
                  // another tab still print what the title claims.
                  setPrintSrc(
                    api.printPDFURL(
                      projectId,
                      versionId,
                      printPrefsToURLOpts(loadPrintPrefs(projectId)),
                    ),
                  );
                }}
                disabled={dirty || printSrc !== null}
                title={
                  dirty
                    ? 'Save your edits first — Quick plot uses the last saved version of this design.'
                    : `Quick plot — print now with the last-used settings, no popover: ${describePrintPrefs(printOpts)}`
                }
              >
                Quick plot
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
          <label className="editor-display-units">
            Show sizes in:{' '}
            <select
              value={displayUnits}
              disabled={unitsSwitching}
              onChange={(e) => changeDisplayUnits(e.target.value as DisplayUnits)}
              title="Display unit for DIMENSIONS — rulers, dimension lines, guide positions, canvas size. Glass stays millimetres everywhere (tube ø, wall, bend radius), and the design itself is stored in mm whichever you pick."
            >
              <option value="mm">millimetres</option>
              <option value="in">inches</option>
            </select>
            {unitsSwitching && <span className="meta"> · Saving…</span>}
          </label>
          {' · '}
          {doc.runs.length} runs · {totalElectrodes} electrodes placed · drag to pan, wheel to zoom · shift+click an electrode to delete
        </p>
        {statusMessage && (
          // Tier 2 #72 — transient confirmation toast for the auto-batch
          // ops (doubleback-all / housing-all). Auto-clears after 5s.
          <p className="meta" role="status" aria-live="polite">{statusMessage}</p>
        )}
        <ValidationBadge
          report={report}
          validating={validating || specSwitching}
          units={displayUnits}
        />
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
          onSetTool={setTool}
          onSetSegmentType={setSegmentType}
          onFlipSegmentArc={flipSegmentArc}
          selectedGuidelineId={selectedGuidelineId}
          onSelectGuideline={setSelectedGuidelineId}
          onMoveGuideline={moveGuideline}
          onDeleteGuideline={deleteRacewayGuideline}
          onDragRacewayEnd={dragRacewayEnd}
          onAddGuide={addConstructionGuide}
          showRulers={showRulers}
          units={displayUnits}
          onPlaceBlockout={placeBlockout}
          onPlaceAnnotation={placeAnnotation}
          onDeleteAnnotation={deleteAnnotation}
          onPlaceBend={placeBend}
          onPlaceLabel={placeLabel}
          textSession={textSession}
          textOptions={{
            font: textFontKey,
            capHeightMM: textCapHeightMM,
            lineHeight: 1.2,
          }}
          onTextSessionChange={setTextSession}
          onEndTextSession={endTextSession}
          onPlaceDimension={placeDimension}
          onDeleteLabel={deleteLabel}
          onDeleteDimension={deleteDimension}
          onMoveVertex={moveVertex}
          onMoveVertices={moveVertices}
          onScaleRuns={scaleRuns}
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
          focusedElement={focusedElement}
        />
        <div
          className="editor-sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize panel · double-click to reset"
          onPointerDown={beginSidebarResize}
          onPointerMove={onSidebarResizeMove}
          onPointerUp={endSidebarResize}
          onDoubleClick={() => setSidebarWidth(340)}
        />
        <aside
          className="editor-sidebar"
          style={{ flexBasis: sidebarWidth, width: sidebarWidth }}
        >
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
              units={displayUnits}
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
              Each existing group exposes inline rename + Dissolve.

              Tier 3 #33c renames this section to "Layers" and adds
              eye + padlock toggles per group. The icons act as
              click-protect / display-only toggles; clicking the row
              body still selects the group's members (Layers sidebar
              is the deliberate escape hatch that bypasses the lock,
              so the operator can edit a locked layer's runs through
              explicit selection). */}
          <div className="groups-header">
            <h3>Layers ({doc.groups?.length ?? 0})</h3>
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
                const visible = g.visible !== false;
                const locked = !!g.locked;
                const dimClass = visible ? '' : ' layer-hidden';
                const lockClass = locked ? ' layer-locked' : '';
                return (
                  <li
                    key={g.id}
                    className={`group-row layer-row${dimClass}${lockClass}`}
                  >
                    <button
                      type="button"
                      className={`layer-icon-btn${visible ? '' : ' off'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleGroupVisible(g.id);
                      }}
                      aria-label={visible ? `Hide layer ${g.name}` : `Show layer ${g.name}`}
                      aria-pressed={!visible}
                      title={
                        visible
                          ? 'Hide this layer (canvas only — validation, save, PDF still see it).'
                          : 'Show this layer.'
                      }
                    >
                      <Eye open={visible} />
                    </button>
                    <button
                      type="button"
                      className={`layer-icon-btn${locked ? ' on' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleGroupLocked(g.id);
                      }}
                      aria-label={locked ? `Unlock layer ${g.name}` : `Lock layer ${g.name}`}
                      aria-pressed={locked}
                      title={
                        locked
                          ? 'Unlock this layer (canvas clicks pick its runs again).'
                          : 'Lock this layer (canvas clicks ignore its runs; this sidebar still selects them).'
                      }
                    >
                      <Padlock locked={locked} />
                    </button>
                    <button
                      type="button"
                      className="group-name btn-link layer-row-body"
                      onClick={() => selectGroupMembers(g.id)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        renameGroupById(g.id);
                      }}
                      title="Click to select this layer's runs; double-click to rename."
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
            {/* Tier 2 #72 — doc-wide electrode helpers. Both gated on
                "doc has at least one electrode". Doubleback-all sweeps
                every open-run termination and inserts a hairpin; idempotent
                across re-runs. Housing-all opens the housing picker and
                applies the chosen type to every un-housed electrode in
                one undo step. */}
            <button
              type="button"
              className="btn-secondary"
              disabled={totalElectrodes === 0}
              onClick={autoDoublebackAll}
              title="Insert a doubleback U-bend at every open-run electrode termination on the doc. Idempotent — terminations already wearing a hairpin are skipped. Wraps the per-segment Insert doubleback tool. Tier 2 #72."
            >
              Auto-doubleback all
            </button>
            {/* Tier 2 #75 — one-click remedy for the max_segment_length
                validator error. Disabled when the spec carries no limit, or
                when nothing on the doc exceeds it. */}
            {/* Tier 2 #74 — raceway guideline. Add drops a horizontal line at
                the design's vertical centre; splitting is a separate,
                explicit click, because a construction line existing is not
                the same as consenting to cut every tube that touches it. */}
            <button
              type="button"
              className="btn-secondary"
              onClick={addRacewayGuideline}
              title="Drop a horizontal raceway guideline at the design's vertical centre. Drag it into position, then use Split tubes at raceway. Tier 2 #74."
            >
              Add raceway guideline
            </button>
            {/* Tier 2 #91 — gated on the selected guideline actually being a
                RACEWAY. A construction guide is inert layout scaffolding; if
                one reached splitTubesAtRaceway it would cut every tube at the
                line and stamp them into a strip page that means nothing. */}
            <button
              type="button"
              className="btn-secondary"
              disabled={!racewaySelected}
              onClick={splitTubesAtRaceway}
              title={
                racewaySelected
                  ? `Cut every tube crossing ${selectedGuidelineId} at the crossing and tag the pieces with it, so they share one back-channel strip. Re-running is a no-op. Tier 2 #74.`
                  : 'Select a raceway guideline on the canvas first. Construction guides are layout-only and cannot split tubes.'
              }
            >
              Split tubes at raceway
            </button>
            {/* Tier 2 #104 / NW #133 — the raceway as modelled hardware.
                Shown only when a RACEWAY guideline is selected, because the
                box has no identity apart from that guideline: same id, top
                edge from its y_mm. Everything here is overridable on
                purpose — the 8in x 8in defaults are current commercial
                practice from supplier pages, not a codified trade rule
                (docs/neon-rules/raceway.md). */}
            {racewaySelected && !selectedRaceway && (
              <button
                type="button"
                className="btn-secondary"
                onClick={createRacewayBox}
                title="Model the aluminium box this guideline's letters mount to: 8in x 8in by default, auto-fitted to the runs already tagged with this raceway. Adds a dimensioned page to the print PDF. Tier 2 #104."
              >
                Model raceway box
              </button>
            )}
            {racewaySelected && selectedRaceway && (
              <div
                className="raceway-box-editor"
                title="The raceway is a rectangular aluminium enclosure that mounts to the building and houses the transformers, wiring and disconnect. Its top edge is this guideline; the numbers below are the rest of the box."
              >
                <div className="raceway-box-header">
                  Raceway {selectedRaceway.id} · {selectedRacewayMembers}{' '}
                  {selectedRacewayMembers === 1 ? 'run' : 'runs'}
                  {ops.racewaySpliceCount(selectedRaceway) > 0
                    ? ` · ${ops.racewaySpliceCount(selectedRaceway)} splice${
                        ops.racewaySpliceCount(selectedRaceway) === 1 ? '' : 's'
                      }`
                    : ''}
                </div>
                {/* <NumericField> on every one of these: it renders
                    step="any", which is what these already declared by
                    hand. `min` makes a lattice out of a numeric `step`,
                    and a default value off that lattice silently swallows
                    the form submit — shipped twice already (CLAUDE.md,
                    recurring bug class 3). Tier 3 #112 moved the guarantee
                    from discipline to the type system. */}
                <label className="diameter-picker">
                  Left x (mm)
                  <NumericField
                    value={selectedRaceway.x_mm}
                    onChange={(e) => setRacewayGeometry('x_mm', Number(e.target.value))}
                  />
                </label>
                <label className="diameter-picker">
                  Length (mm)
                  <NumericField
                    value={selectedRaceway.length_mm}
                    onChange={(e) => setRacewayGeometry('length_mm', Number(e.target.value))}
                  />
                </label>
                <label
                  className="diameter-picker"
                  title="Box height. Empty = the 203.2mm (8in) shop default."
                >
                  Height (mm)
                  <NumericField
                    placeholder={String(RACEWAY_DEFAULT_HEIGHT_MM)}
                    value={selectedRaceway.height_mm ?? ''}
                    onChange={(e) => setRacewayGeometry('height_mm', Number(e.target.value))}
                  />
                </label>
                <label
                  className="diameter-picker"
                  title="Box depth, front face to wall. Empty = the 203.2mm (8in) shop default — a 159mm neon transformer cannot sit across a 5in box, which is why the neon-era standard is bigger than the LED-era one."
                >
                  Depth (mm)
                  <NumericField
                    placeholder={String(RACEWAY_DEFAULT_DEPTH_MM)}
                    value={selectedRaceway.depth_mm ?? ''}
                    onChange={(e) => setRacewayGeometry('depth_mm', Number(e.target.value))}
                  />
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={selectedRacewayMembers === 0}
                  onClick={fitRacewayToRuns}
                  title="Re-size the box to span the runs tagged with this raceway, arc-aware. Ends stop FLUSH with the outermost glass: no source says whether a real raceway overhangs, so V1 does not invent a margin (docs/neon-rules/raceway.md, open question 1)."
                >
                  Fit to runs
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={removeRacewayBox}
                  title="Remove the modelled box. The guideline and every raceway tag stay — the glass does not un-cut itself."
                >
                  Remove box
                </button>
              </div>
            )}
            <button
              type="button"
              className="btn-secondary"
              disabled={overlongRunCount === 0}
              onClick={autoSplitOverlong}
              title={
                maxSegmentLengthMM > 0
                  ? `Split every run longer than ${maxSegmentLengthMM}mm into the fewest equal-arc-length pieces that fit under the limit. Evenly spaced, one undo step. Tier 2 #75.`
                  : 'This tube spec has no max segment length, so there is nothing to split against.'
              }
            >
              Split overlong tubes
              {overlongRunCount > 0 ? ` (${overlongRunCount})` : ''}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={totalElectrodes === 0}
              onClick={openAutoHousingPicker}
              title="Apply a housing (15-shell / 19-shell / custom) to every electrode that doesn't already have one. Per-pin custom housings are preserved. Wraps the right-click housing picker. Tier 2 #72."
            >
              Auto-housing all
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
          {/* Tier 2 #90 — Arrange. Renders only with a live selection: with
              nothing picked every control would be disabled, which is just
              noise in an already-dense sidebar. Depth order works on one run
              (it permutes doc.runs, the draw order), so the gate is 1 rather
              than the 2 that align needs. */}
          {selectedRunIds.length > 0 && (
            <div className="arrange-section">
              <div className="groups-header">
                <h3>Arrange</h3>
              </div>
              <ArrangePanel
                doc={doc}
                selectedRunIds={selectedRunIds}
                onAlign={alignSelected}
                onDistribute={distributeSelected}
                onMirror={mirrorSelected}
                onReorder={reorderSelected}
                onStepRepeat={stepRepeatSelected}
              />
            </div>
          )}
          {/* Tier 2 #98 — merge overlapping closed outlines into one
              joinable outline, the thing connected script needs before
              Neonize can run. Renders only when two or more CLOSED runs are
              picked: a union needs an inside, so an open polyline has
              nothing to contribute, and a disabled button with nothing
              selected is just more sidebar noise. */}
          {closedSelectedCount >= 2 && (
            <div className="arrange-section">
              <div className="groups-header">
                <h3>Merge outlines</h3>
              </div>
              <p className="meta">
                Replaces {closedSelectedCount} closed outlines with the boundary of their
                union. Holes come back as their own closed runs. Arcs are flattened to line
                segments — a union boundary has no arc form — and electrodes, blockouts,
                bends and annotations are dropped, because they address vertices the merge
                dissolves.
              </p>
              <button
                type="button"
                className="btn-secondary"
                onClick={mergeOutlinesSelected}
                title="Boolean union of the selected closed outlines (NeonWizard calls this Weld). Overlapping glyph outlines become one continuous boundary that Neonize can turn into a single tube path. Tier 2 #98."
              >
                Merge {closedSelectedCount} outlines
              </button>
            </div>
          )}
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
                {/* Tier 3 #112 — was `step="0.5" min="1"`, a lattice that
                    excluded the two most common trade sizes: 12.7 (1/2in)
                    and 9.525 (3/8in). */}
                <NumericField
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
                    {/* Tier 3 #112 — was `step="1" min="10"`, which put
                        76.2 (3in) and 127 (5in) off the lattice. */}
                    <NumericField
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
                <>
                  <SectionHeader
                    icon="electrode"
                    collapsed={collapsedSections.has('electrodes')}
                    onToggle={() => toggleSection('electrodes')}
                  >
                    Electrodes · {selectedRun.electrodes!.length}
                  </SectionHeader>
                  {!collapsedSections.has('electrodes') && (
                    <>
                      <ul className="panel-item-list">
                        {selectedRun.electrodes!.map((el, ei) => (
                          <li key={ei}>
                            <button
                              type="button"
                              className={`focus-link${
                                focusedElement?.runId === selectedRun.id &&
                                focusedElement.kind === 'electrode' &&
                                focusedElement.index === ei
                                  ? ' active'
                                  : ''
                              }`}
                              onClick={() => focusElementOnCanvas(selectedRun.id, 'electrode', ei)}
                            >
                              Electrode #{ei + 1}
                              <span className="meta"> @ pt {el.point_index}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                      <button type="button" className="btn-secondary" onClick={clearElectrodesOnSelected}>
                        Clear electrodes
                      </button>
                    </>
                  )}
                </>
              )}
              {(selectedRun.blockouts?.length ?? 0) > 0 && (
                <>
                  <SectionHeader
                    icon="blockout"
                    collapsed={collapsedSections.has('blockouts')}
                    onToggle={() => toggleSection('blockouts')}
                  >
                    Blockouts · {selectedRun.blockouts!.length}
                  </SectionHeader>
                  {!collapsedSections.has('blockouts') && (
                    <>
                      <ul className="panel-item-list">
                        {selectedRun.blockouts!.map((b, bi) => (
                          <li key={bi}>
                            <button
                              type="button"
                              className={`focus-link${
                                focusedElement?.runId === selectedRun.id &&
                                focusedElement.kind === 'blockout' &&
                                focusedElement.index === bi
                                  ? ' active'
                                  : ''
                              }`}
                              onClick={() => focusElementOnCanvas(selectedRun.id, 'blockout', bi)}
                            >
                              Blockout #{bi + 1}
                              <span className="meta"> [{b.start_live_index}, {b.end_live_index}]</span>
                            </button>
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
                const collapsed = collapsedSections.has('bends');
                return (
                  <>
                    <SectionHeader
                      icon="bend"
                      collapsed={collapsed}
                      onToggle={() => toggleSection('bends')}
                    >
                      Bends · {bends.length} · total{' '}
                      {bends.reduce((acc, b) => acc + b.angleDeg, 0).toFixed(0)}°
                      {isManual ? ' · manual' : ' · auto'}
                    </SectionHeader>
                    {!collapsed && (
                      <>
                        <ul className="panel-item-list">
                          {bends.map((b, bi) => (
                            <li key={bi}>
                              <button
                                type="button"
                                className={`focus-link${
                                  focusedElement?.runId === selectedRun.id &&
                                  focusedElement.kind === 'bend' &&
                                  focusedElement.index === bi
                                    ? ' active'
                                    : ''
                                }`}
                                onClick={() => focusElementOnCanvas(selectedRun.id, 'bend', bi)}
                              >
                                #{bi + 1}
                                <span className="meta"> @ {b.arcLengthMM.toFixed(1)}mm · {b.angleDeg.toFixed(0)}° · r={b.radiusMM > 0 && Number.isFinite(b.radiusMM) ? `${b.radiusMM.toFixed(1)}mm` : '∞'}</span>
                              </button>
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
                    )}
                  </>
                );
              })()}
              {(selectedRun.annotations?.length ?? 0) > 0 && (
                <>
                  <SectionHeader
                    icon="annotation"
                    collapsed={collapsedSections.has('annotations')}
                    onToggle={() => toggleSection('annotations')}
                  >
                    Annotations · {selectedRun.annotations!.length}
                  </SectionHeader>
                  {!collapsedSections.has('annotations') && (
                    <>
                      <ul className="panel-item-list">
                        {selectedRun.annotations!.map((a, ai) => (
                          <li key={ai}>
                            <button
                              type="button"
                              className={`focus-link${
                                focusedElement?.runId === selectedRun.id &&
                                focusedElement.kind === 'annotation' &&
                                focusedElement.index === ai
                                  ? ' active'
                                  : ''
                              }`}
                              onClick={() => focusElementOnCanvas(selectedRun.id, 'annotation', ai)}
                            >
                              <span className="focus-link-icon">
                                <CategoryIcon kind={a.kind as IconKind} />
                              </span>
                              {a.kind}
                              <span className="meta"> @ live {a.live_index}</span>
                            </button>
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
      {outlineTextOpen && (
        <Suspense fallback={null}>
          <OutlineTextDialog
            onCancel={() => setOutlineTextOpen(false)}
            onInsert={(runs) => insertOutlineText(runs)}
          />
        </Suspense>
      )}
      {channelLetterOpen && (
        <ChannelLetterWizardDialog
          onCancel={() => setChannelLetterOpen(false)}
          onInsert={(runs) => insertChannelLetterWizardOutput(runs)}
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
      {autoHousingOpen && (() => {
        // Tier 2 #72 — doc-wide housing picker. Reuses the per-electrode
        // modal so the operator sees the same form (stock 15/19, custom
        // bore + elevation). The caption flags that the choice will
        // broadcast across every un-housed electrode. Skipping ones
        // already housed preserves the per-pin custom edits a careful
        // operator might have made.
        const eligible = doc.runs.reduce((acc, r) => {
          for (const e of r.electrodes ?? []) {
            const eh = e as ElectrodeWithHousing;
            if (!eh.housing_type) acc++;
          }
          return acc;
        }, 0);
        const caption = `All electrodes · ${eligible} of ${totalElectrodes} will be updated (others already housed)`;
        return (
          <HousingPickerModal
            initial={{ housing_type: 'shell-15' as HousingType }}
            caption={caption}
            onCancel={() => setAutoHousingOpen(false)}
            onSave={applyAutoHousing}
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
        {/* Tier 3 #112 — was `step="0.1" min="0"`; PR #158's flatten
            tolerance shipped the same shape and 0.05 / 0.25 are exactly
            the values it could not express. */}
        <NumericField
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
  units,
}: {
  report: ValidationReport | null;
  validating: boolean;
  units: DisplayUnits;
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
      {summary} · {report.tube_runs} runs · {formatFootageMM(report.total_length_mm, units)} total tube
    </p>
  );
}
