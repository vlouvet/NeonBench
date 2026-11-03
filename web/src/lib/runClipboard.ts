// Tier 3 #150 / #151 — arrow-key nudge and an in-app clipboard for tube runs.
//
// The clipboard is module state rather than component state so a copy survives
// moving to another design in the same tab, which is how a shop reuses a logo
// between jobs. It is not the OS clipboard: a run is only meaningful here, and
// a browser only allows reading that one around a user gesture.
//
// Pasting can land in a DIFFERENT doc, which is the one way this differs from
// step-and-repeat, and it makes every foreign key a hazard:
//
//   circuit_id   REPLACED by a new circuit per source circuit, per paste, as
//                group_id is. The clipboard carries the source circuits that
//                the copied runs reference, and paste makes a fresh one for
//                each from the growing list. A circuit is capped at one
//                electrode pair, so carrying the source's id would miscount a
//                pasted transformer; naming a circuit the target lacks would
//                400 every later save.
//   raceway_id   DROPPED by copyRun: a copy is not on that back-channel.
//   group_id     REPLACED by a new group per source group, for the reason the
//                stepRepeat header gives: a group is "these runs are one unit".
//
// Ops are pure and return the SAME doc object when there is nothing to do, as
// `arrange.ts` does, because undo coalescing keys off reference identity.

import type { Circuit, DesignDoc, DesignRun, Group } from '../api';
import { arrangeableRunIds, translateRun } from './arrange';
import { nextCircuitId, nextGroupId, nextRunId } from './docOps';
import { copyRun } from './stepRepeat';

export type RunClipboard = {
  runs: DesignRun[];
  /** Source group id to its name and visibility, for naming the new groups. */
  groups: Group[];
  /** Source circuits the copied runs reference, for naming the new ones. */
  circuits: Circuit[];
  /** How many times this copy has been pasted, so pastes fan out. */
  pasteCount: number;
};

let held: RunClipboard | null = null;

export function heldClipboard(): RunClipboard | null {
  return held;
}

export function holdClipboard(clip: RunClipboard | null): void {
  held = clip;
}

/** Snapshot the selection, skipping locked runs. Null when nothing is left. */
export function copySelection(doc: DesignDoc, runIds: readonly string[]): RunClipboard | null {
  const ids = new Set(arrangeableRunIds(doc, runIds));
  if (ids.size === 0) return null;
  const runs = doc.runs
    .filter((r) => ids.has(r.id))
    .map((r) => copyRun(r, r.id, 0, 0, r.group_id, r.circuit_id));
  const groupIds = new Set(runs.map((r) => r.group_id).filter(Boolean));
  const circuitIds = new Set(runs.map((r) => r.circuit_id).filter(Boolean));
  return {
    runs,
    groups: (doc.groups ?? []).filter((g) => groupIds.has(g.id)),
    circuits: (doc.circuits ?? []).filter((c) => circuitIds.has(c.id)),
    pasteCount: 0,
  };
}

export type PasteResult = { doc: DesignDoc; newIds: string[] };

/** Append a copy of the clipboard, offset by (dx, dy), to the end of `doc`. */
export function pasteRuns(doc: DesignDoc, clip: RunClipboard, dx: number, dy: number): PasteResult {
  const runs = doc.runs.slice();
  const groups: Group[] = [...(doc.groups ?? [])];
  const circuits: Circuit[] = [...(doc.circuits ?? [])];
  const pastedGroups = new Map<string, string>();
  const pastedCircuits = new Map<string, string>();
  const newIds: string[] = [];

  for (const src of clip.runs) {
    let groupId: string | undefined;
    if (src.group_id) {
      groupId = pastedGroups.get(src.group_id);
      if (!groupId) {
        groupId = nextGroupId({ ...doc, groups });
        const base = clip.groups.find((g) => g.id === src.group_id);
        const group: Group = { id: groupId, name: `${base?.name ?? src.group_id} copy` };
        if (base?.visible === false) group.visible = false;
        groups.push(group);
        pastedGroups.set(src.group_id, groupId);
      }
    }
    // One new circuit per SOURCE circuit per paste, so a traced sign's
    // fragments stay on one circuit each paste. A held run whose circuit is
    // missing from the clipboard still gets a fresh, unnamed circuit.
    let circuitId: string | undefined;
    if (src.circuit_id) {
      circuitId = pastedCircuits.get(src.circuit_id);
      if (!circuitId) {
        circuitId = nextCircuitId({ ...doc, circuits });
        const base = clip.circuits.find((c) => c.id === src.circuit_id);
        const circuit: Circuit = { id: circuitId };
        if (base?.name) circuit.name = `${base.name} copy`;
        circuits.push(circuit);
        pastedCircuits.set(src.circuit_id, circuitId);
      }
    }
    const id = nextRunId({ ...doc, runs });
    const copy = copyRun(src, id, dx, dy, groupId, circuitId);
    runs.push(copy);
    newIds.push(id);
  }

  const next: DesignDoc = { ...doc, runs };
  // A doc that never had the key should not grow an empty array on save.
  if (groups.length > (doc.groups?.length ?? 0)) next.groups = groups;
  if (circuits.length > (doc.circuits?.length ?? 0)) next.circuits = circuits;
  return { doc: next, newIds };
}

/** Move the selection, skipping locked runs. */
export function nudgeSelection(
  doc: DesignDoc,
  runIds: readonly string[],
  dx: number,
  dy: number,
): DesignDoc {
  const ids = new Set(arrangeableRunIds(doc, runIds));
  if (ids.size === 0 || (dx === 0 && dy === 0)) return doc;
  return { ...doc, runs: doc.runs.map((r) => (ids.has(r.id) ? translateRun(r, dx, dy) : r)) };
}
