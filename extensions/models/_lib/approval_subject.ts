// Swamp, an Automation Framework Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify it under the terms
// of the GNU Affero General Public License version 3 as published by the Free
// Software Foundation, with the Swamp Extension and Definition Exception (found in
// the "COPYING-EXCEPTION.txt" file).
//
// Swamp is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with Swamp. If not, see <https://www.gnu.org/licenses/>.

import type {
  ApprovalSubjectSpec,
  FactoryArguments,
  GateSpec,
  TransitionSpec,
} from "./definition_schema.ts";
import { z } from "npm:zod@4.3.6";
import { transitionsFrom } from "./definition_schema.ts";
import type { RunState, RunView } from "./run_data.ts";
import { currentCycle } from "./run_data.ts";

// ---------------------------------------------------------------------------
// Approval-subject binding.
//
// A human-approval gate answers "did a human say yes?". Without binding, that
// is all it answers: the approval is scoped to (gateId, stageId, cycle), so an
// artifact or evidence record can be mutated after the human looked at it and
// the same approval still satisfies the same gate. The human approved a
// *thing*; the gate only remembered the *slot*.
//
// Subject binding closes that: a gate may declare which artifacts and evidence
// the approval is *of*. `approve`/`reject` compute an exact digest of those
// records from trusted recorded data, and gate evaluation recomputes it and
// requires an exact match. Any re-record — even one whose payload bytes are
// unchanged — moves the envelope's identity (version, recordedAt) and so
// invalidates the decision. Fail-closed by construction: an unbound approval
// can never satisfy a subject-bound gate.
// ---------------------------------------------------------------------------

/** Manifest format version. Bump only on a breaking manifest-shape change. */
export const APPROVAL_SUBJECT_VERSION = "approval-subject-v1";

/** Digest algorithm identifier recorded alongside every computed digest. */
export const APPROVAL_SUBJECT_ALGORITHM = "sha-256";

/** Comparison-scope contract. Independent of recorded payload identities. */
export const APPROVAL_SUBJECT_CONTRACT_VERSION = "approval-subject-contract-v1";

export interface ApprovalSubjectContract {
  version: string;
  digest: string;
}

/**
 * Stable identity for selecting a previous approval to compare with. It binds
 * the exact gate/transition and canonical selector contract, but deliberately
 * excludes the selected records and their versions/content.
 */
export async function computeApprovalSubjectContract(opts: {
  gateId: string;
  transition: string;
  subject: ApprovalSubjectSpec;
}): Promise<ApprovalSubjectContract> {
  const contract = {
    version: APPROVAL_SUBJECT_CONTRACT_VERSION,
    gateId: opts.gateId,
    transition: opts.transition,
    subject: {
      artifacts: opts.subject.artifacts ?? [],
      evidence: opts.subject.evidence ?? [],
      includeRun: includeRun(opts.subject),
      includeDefinition: includeDefinition(opts.subject),
    },
    manifestVersion: APPROVAL_SUBJECT_VERSION,
  };
  return {
    version: APPROVAL_SUBJECT_CONTRACT_VERSION,
    digest: await sha256Hex(canonicalJson(contract)),
  };
}

// ---------------------------------------------------------------------------
// Deterministic canonical JSON
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serialization: object keys sorted recursively (by UTF-16 code
 * unit, `Array.prototype.sort`'s default — the same total order everywhere JS
 * runs), array order preserved, string bytes preserved verbatim.
 *
 * Deliberately *not* a general JSON canonicalizer: it rejects what it cannot
 * represent stably rather than coercing it. `undefined` is dropped from objects
 * (it has no JSON form); non-finite numbers and functions/symbols throw, so a
 * digest is never computed over a value that would serialize differently on a
 * later read.
 */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value, []);
}

function writeCanonical(value: unknown, path: string[]): string {
  if (value === null) return "null";

  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return value === true ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(
        `cannot canonicalize non-finite number at ${pathLabel(path)}`,
      );
    }
    // JSON.stringify emits the shortest round-tripping representation, which
    // is stable across engines for finite doubles.
    return JSON.stringify(value);
  }
  if (type === "bigint") {
    throw new Error(`cannot canonicalize bigint at ${pathLabel(path)}`);
  }
  if (type === "function" || type === "symbol" || type === "undefined") {
    throw new Error(`cannot canonicalize ${type} at ${pathLabel(path)}`);
  }

  if (Array.isArray(value)) {
    // Array order is meaningful data — never sorted.
    const items = value.map((item, index) =>
      writeCanonical(item, [...path, String(index)])
    );
    return `[${items.join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined)
    .sort();
  const entries = keys.map((key) =>
    `${JSON.stringify(key)}:${writeCanonical(record[key], [...path, key])}`
  );
  return `{${entries.join(",")}}`;
}

function pathLabel(path: string[]): string {
  return path.length === 0 ? "(root)" : path.join(".");
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Identity of one selected artifact/evidence record inside a subject manifest.
 * `payloadDigest` covers the content; the envelope fields cover *which
 * recording* it was, so re-recording identical bytes still moves the digest.
 */
export interface SubjectRecordIdentity {
  kind: "artifact" | "evidence";
  name: string;
  version: number;
  stageId: string;
  cycle: number;
  recordedAt: string;
  payloadDigest: string;
}

/** A named record the gate selects that has not been recorded yet. */
export interface MissingSubjectRecord {
  kind: "artifact" | "evidence";
  name: string;
}

export interface ApprovalSubjectManifest {
  /** Manifest format version — part of the digested bytes. */
  manifestVersion: string;
  gate: { id: string };
  workItem: string;
  /** Where the approval is being given: the gate's (stage, cycle) slot. */
  run?: {
    stageId: string;
    cycle: number;
    /** The run era (`state.startedAt`), so a `reset` invalidates decisions. */
    era: string;
  };
  /** Definition identity, so a mid-run definition edit invalidates decisions. */
  definition?: {
    name: string;
    version: number;
  };
  records: SubjectRecordIdentity[];
}

const SubjectRecordIdentitySchema = z.strictObject({
  kind: z.enum(["artifact", "evidence"]),
  name: z.string(),
  version: z.number().int().positive(),
  stageId: z.string(),
  cycle: z.number().int().positive(),
  recordedAt: z.string(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export const ApprovalSubjectManifestSchema = z.strictObject({
  manifestVersion: z.literal(APPROVAL_SUBJECT_VERSION),
  gate: z.strictObject({ id: z.string() }),
  workItem: z.string(),
  run: z.strictObject({
    stageId: z.string(),
    cycle: z.number().int().positive(),
    era: z.string(),
  }).optional(),
  definition: z.strictObject({
    name: z.string(),
    version: z.number().int().positive(),
  }).optional(),
  records: z.array(SubjectRecordIdentitySchema),
});

export function parseApprovalSubjectManifest(
  value: unknown,
): ApprovalSubjectManifest {
  return ApprovalSubjectManifestSchema.parse(value);
}

export interface ApprovalSubject {
  manifest: ApprovalSubjectManifest;
  digest: string;
  algorithm: string;
  /** Selected records the run has not recorded — the subject is incomplete. */
  missing: MissingSubjectRecord[];
}

/**
 * Compute the current subject of a subject-bound human-approval gate from
 * trusted recorded data (the run view and state) — never from caller input.
 *
 * The digest covers the whole manifest, so it moves when *any* selected
 * record's identity or content moves, and (per config) when the run slot or
 * definition identity moves.
 */
export async function computeApprovalSubject(opts: {
  gateId: string;
  subject: ApprovalSubjectSpec;
  workItem: string;
  state: RunState;
  view: RunView;
  definition?: { name: string; version: number };
}): Promise<ApprovalSubject> {
  const { subject } = opts;
  const records: SubjectRecordIdentity[] = [];
  const missing: MissingSubjectRecord[] = [];

  // Selection order is the definition's declared order, not recorded order:
  // the manifest must be a function of (definition, run data), never of the
  // order the platform happened to hand records back in.
  for (const name of subject.artifacts ?? []) {
    const recorded = opts.view.artifacts.get(name);
    if (recorded === undefined) {
      missing.push({ kind: "artifact", name });
      continue;
    }
    records.push({
      kind: "artifact",
      name,
      version: recorded.version,
      stageId: recorded.latest.stageId,
      cycle: recorded.latest.cycle,
      recordedAt: recorded.latest.recordedAt,
      payloadDigest: await sha256Hex(canonicalJson(recorded.latest.payload)),
    });
  }
  for (const name of subject.evidence ?? []) {
    const recorded = opts.view.evidence.get(name);
    if (recorded === undefined) {
      missing.push({ kind: "evidence", name });
      continue;
    }
    records.push({
      kind: "evidence",
      name,
      version: recorded.version,
      stageId: recorded.latest.stageId,
      cycle: recorded.latest.cycle,
      recordedAt: recorded.latest.recordedAt,
      payloadDigest: await sha256Hex(canonicalJson(recorded.latest.payload)),
    });
  }

  const manifest: ApprovalSubjectManifest = {
    manifestVersion: APPROVAL_SUBJECT_VERSION,
    gate: { id: opts.gateId },
    workItem: opts.workItem,
    records,
  };
  if (includeRun(subject)) {
    manifest.run = {
      stageId: opts.state.stageId,
      cycle: currentCycle(opts.state),
      era: opts.state.startedAt,
    };
  }
  if (includeDefinition(subject) && opts.definition !== undefined) {
    manifest.definition = {
      name: opts.definition.name,
      version: opts.definition.version,
    };
  }

  return {
    manifest,
    digest: await sha256Hex(canonicalJson(manifest)),
    algorithm: APPROVAL_SUBJECT_ALGORITHM,
    missing,
  };
}

/** `includeRun` defaults to true — the run slot is part of the subject. */
export function includeRun(subject: ApprovalSubjectSpec): boolean {
  return subject.includeRun !== false;
}

/** `includeDefinition` defaults to true — the rules are part of the subject. */
export function includeDefinition(subject: ApprovalSubjectSpec): boolean {
  return subject.includeDefinition !== false;
}

/** Human-readable one-liner naming what a manifest binds. */
export function describeSubject(subject: ApprovalSubjectSpec): string {
  const parts: string[] = [];
  for (const name of subject.artifacts ?? []) parts.push(`artifact '${name}'`);
  for (const name of subject.evidence ?? []) parts.push(`evidence '${name}'`);
  return parts.join(", ") || "(no records selected)";
}

// ---------------------------------------------------------------------------
// Gate lookup: which subject config applies to a gateId right now
// ---------------------------------------------------------------------------

export interface ResolvedApprovalGate {
  gate: Extract<GateSpec, { type: "human-approval" }>;
  transition: TransitionSpec;
}

/**
 * Every human-approval gate with this id reachable from the run's current
 * stage (its own transitions plus global ones). This is the set `approve` and
 * `reject` must agree with — a decision recorded now is only ever consumed by
 * one of these.
 */
export function approvalGatesInScope(
  args: FactoryArguments,
  stageId: string,
  gateId: string,
): ResolvedApprovalGate[] {
  const stage = args.stages.find((s) => s.id === stageId);
  if (stage === undefined) return [];
  const found: ResolvedApprovalGate[] = [];
  for (const transition of transitionsFrom(args, stage)) {
    for (const gate of transition.gates ?? []) {
      if (gate.type === "human-approval" && gate.config.id === gateId) {
        found.push({ gate, transition });
      }
    }
  }
  return found;
}

/**
 * The subject config a decision on `gateId` should bind to, given the gates in
 * scope. Returns `undefined` when the gate is unbound (no subject config) —
 * the legacy shape, which stays exactly as it was.
 *
 * Ambiguity is a hard error, not a guess: if the same id appears on several
 * reachable transitions with *different* subject configs, one digest cannot
 * satisfy all of them, so the caller must disambiguate with `transition`.
 * Identical configs (the normal case of one id gating sibling branches)
 * resolve silently — they are the same subject by definition.
 */
export function resolveSubjectSpec(
  gates: ResolvedApprovalGate[],
): { spec: ApprovalSubjectSpec | undefined; ambiguous: string[] } {
  if (gates.length === 0) return { spec: undefined, ambiguous: [] };
  const distinct = new Map<string, string[]>();
  for (const { gate, transition } of gates) {
    // canonicalJson over the config makes "same subject" an exact, key-order
    // independent comparison rather than a field-by-field guess.
    const key = canonicalJson(gate.config.subject ?? null);
    const transitions = distinct.get(key) ?? [];
    transitions.push(transition.name);
    distinct.set(key, transitions);
  }
  if (distinct.size > 1) {
    return {
      spec: undefined,
      ambiguous: gates.map((g) => g.transition.name),
    };
  }
  return { spec: gates[0].gate.config.subject, ambiguous: [] };
}
