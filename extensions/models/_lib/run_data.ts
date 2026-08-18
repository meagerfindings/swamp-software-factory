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

import { z } from "npm:zod@4.3.6";

// ---------------------------------------------------------------------------
// Run-time data: state, artifact/evidence envelopes, approvals, journal.
//
// One factory instance serves many work items. Every record is namespaced by
// the work item's slug in its instance name (state-<slug>,
// artifact-<slug>-<name>, …) and stamped with the original workItem string
// in its envelope. All data is versioned and immutable.
// ---------------------------------------------------------------------------

export const RunStateSchema = z.object({
  workItem: z.string(),
  stageId: z.string(),
  cycles: z.record(z.string(), z.number().int().positive()),
  /**
   * Per-stage dispatch counter, scoped to the current entry into that stage.
   * `record_dispatch` increments `count` while `cycle` matches the stage's
   * current cycle, and resets to the new cycle on re-entry. The deterministic
   * input to the runaway-loop guard: re-dispatching the same (stage, cycle)
   * is counted from recorded state, not agent memory.
   */
  dispatches: z.record(
    z.string(),
    z.object({
      cycle: z.number().int().positive(),
      count: z.number().int().positive(),
    }),
  ).optional(),
  enteredAt: z.string(),
  status: z.enum(["active", "terminal"]),
  definitionVersion: z.number().int().positive(),
  definitionHash: z.string().optional(),
  startedAt: z.string(),
});

export type RunState = z.infer<typeof RunStateSchema>;

export const ArtifactEnvelopeSchema = z.object({
  name: z.string(),
  workItem: z.string(),
  stageId: z.string(),
  cycle: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  subjectVersion: z.number().int().positive().optional(),
  recordedAt: z.string(),
  resolvedAt: z.string().optional(),
  note: z.string().optional(),
});

export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;

export const EvidenceEnvelopeSchema = z.object({
  name: z.string(),
  workItem: z.string(),
  stageId: z.string(),
  cycle: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  recordedAt: z.string(),
});

export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

/**
 * A recorded payload-validation failure, written by `record_artifact` /
 * `record_evidence` when they reject a malformed payload (then re-thrown).
 * It persists the rejected value and the path-bearing errors so a retry can
 * bind them back into the model's prompt (`feedback`). `cleared: true` is the
 * marker written when a later attempt records the target successfully — it
 * keeps `data.latest(...)` truthful so a fresh entry never binds a stale
 * failure.
 */
export const ValidationEnvelopeSchema = z.object({
  target: z.string(),
  targetKind: z.enum(["artifact", "evidence"]),
  workItem: z.string(),
  stageId: z.string(),
  cycle: z.number().int().positive(),
  attempt: z.number().int().nonnegative(),
  cleared: z.boolean(),
  rejected: z.unknown().optional(),
  errors: z.array(z.string()),
  recordedAt: z.string(),
});

export type ValidationEnvelope = z.infer<typeof ValidationEnvelopeSchema>;

/**
 * What a decision was a decision *of*, when the gate declares a subject
 * binding. Every field is optional so records written before subject binding
 * existed stay readable exactly as they are — they are `unbound` decisions,
 * and gate evaluation treats them as such (see gates.humanApproval). Old
 * approvals are never backfilled: a digest invented after the fact would
 * assert a human reviewed something they never saw.
 *
 * `manifest` is stored verbatim rather than only the digest, so an auditor can
 * see *what* was approved without recomputing it, and so a mismatch can be
 * explained field by field instead of as two opaque hashes.
 */
export const ApprovalSubjectBindingSchema = z.object({
  /** Digest of the canonical manifest below (hex). */
  digest: z.string(),
  /** Digest algorithm, recorded so the format can evolve readably. */
  algorithm: z.string(),
  /** Manifest format version (`approval-subject-v1`). */
  manifestVersion: z.string(),
  /** The manifest the digest was computed over. */
  manifest: z.record(z.string(), z.unknown()),
});

export type ApprovalSubjectBinding = z.infer<
  typeof ApprovalSubjectBindingSchema
>;

export const ApprovalRecordSchema = z.object({
  gateId: z.string(),
  workItem: z.string(),
  decision: z.enum(["approved", "rejected"]),
  actor: z.string(),
  note: z.string().optional(),
  stageId: z.string(),
  cycle: z.number().int().positive(),
  decidedAt: z.string(),
  /**
   * Whether this decision is bound to a computed subject. `unbound` is the
   * legacy shape and the shape of any decision on a gate that declares no
   * subject; it is written explicitly on new records so a reader never has to
   * infer intent from a missing field.
   */
  subjectStatus: z.enum(["bound", "unbound"]).optional(),
  subject: ApprovalSubjectBindingSchema.optional(),
  /** Exact comparison scope; absent legacy values are never inferred. */
  comparisonIdentity: z.object({
    transition: z.string(),
    runEra: z.string(),
    subjectContractVersion: z.string(),
    subjectContractDigest: z.string(),
  }).optional(),
  /** Canonical identity for an accumulating approved recovery grant. */
  recoveryGrantIdentity: z.object({
    format: z.literal("override-grant-v1"),
    runEra: z.string(),
    workItem: z.string(),
    gateId: z.string(),
    scopeStageId: z.string(),
    scopeCycle: z.number().int().positive().nullable(),
    failureSignature: z.string(),
  }).optional(),
});

export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/** Preserve the pre-comparison gate/CEL approval contract. */
function gateVisibleApproval(record: ApprovalRecord): ApprovalRecord {
  const {
    comparisonIdentity: _comparisonIdentity,
    recoveryGrantIdentity: _recoveryGrantIdentity,
    ...visible
  } = record;
  return visible;
}

export const JournalEntrySchema = z.object({
  event: z.string(),
  workItem: z.string(),
  stageId: z.string().optional(),
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  at: z.string(),
});

export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/**
 * The materialized `status` view: the full self-describing packet `status`
 * computes (current stage, resolved work spec, per-transition gate results,
 * context manifest, cycle counts) persisted as a queryable record
 * (`status-<slug>`) instead of dumped to a log line. Its shape is large and
 * partly dynamic (the embedded `work` spec varies per stage), so the resource
 * layer validates only that it is a JSON object — the driver reads exactly the
 * fields it needs with `swamp data query --select`, never the whole blob.
 */
export const StatusEnvelopeSchema = z.record(z.string(), z.unknown());

export type StatusEnvelope = z.infer<typeof StatusEnvelopeSchema>;

/** Durable, provider-neutral lease for one workflow attempt. */
export const AttemptLeaseSchema = z.object({
  workItem: z.string(),
  attemptId: z.string().min(1),
  stageId: z.string(),
  status: z.enum(["leased", "completed", "orphaned"]),
  owner: z.string().min(1),
  leasedAt: z.string(),
  heartbeatAt: z.string(),
  expiresAt: z.string(),
  completedAt: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  decision: z.enum(["retry", "fail", "stop"]).optional(),
  reason: z.string().optional(),
});
export type AttemptLease = z.infer<typeof AttemptLeaseSchema>;

// ---------------------------------------------------------------------------
// Work-item slugs and instance naming live in run_names.ts (zod-free so
// report extensions can bundle them); re-exported here for the engine.
// ---------------------------------------------------------------------------

export {
  APPROVAL_PREFIX,
  approvalInstance,
  ARTIFACT_PREFIX,
  artifactInstance,
  EVIDENCE_PREFIX,
  evidenceInstance,
  JOURNAL_PREFIX,
  journalInstance,
  overrideApprovalInstance,
  overrideGrantDigest,
  OVERVIEW_SLUG,
  STATE_PREFIX,
  stateInstance,
  STATUS_PREFIX,
  statusInstance,
  VALIDATION_PREFIX,
  validationInstance,
  workItemSlug,
} from "./run_names.ts";

import {
  APPROVAL_PREFIX,
  approvalInstance,
  ARTIFACT_PREFIX,
  EVIDENCE_PREFIX,
  overrideApprovalInstance,
  overrideGrantDigest,
  STATE_PREFIX,
  stateInstance,
  VALIDATION_PREFIX,
} from "./run_names.ts";

// ---------------------------------------------------------------------------
// RunView: a materialized snapshot of everything ONE work item's run has
// recorded on this instance. Gate evaluation, CEL contexts, and status
// rendering all read from this. Maps are keyed by logical names ("plan"),
// never physical instance names.
// ---------------------------------------------------------------------------

/** The slice of swamp's data repository the engine needs. */
export interface DataRepositoryLike {
  findAllForModel(
    type: unknown,
    modelId: string,
  ): Promise<{ name: string; version: number }[]>;
  getContent(
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
  /**
   * Every stored version of a data name, ascending. Present on swamp's
   * UnifiedDataRepository; the summary's repository-backed reader needs it
   * because `findAllForModel` only surfaces the latest version per name.
   */
  listVersions?(
    type: unknown,
    modelId: string,
    dataName: string,
  ): Promise<number[]>;
}

export interface ArtifactView {
  latest: ArtifactEnvelope;
  /** Version number of the latest record. */
  version: number;
}

export interface EvidenceView {
  latest: EvidenceEnvelope;
  version: number;
}

export interface ValidationView {
  latest: ValidationEnvelope;
  version: number;
}

export type VersionedApprovalRecord = ApprovalRecord & {
  /** Immutable data-resource version, not a timestamp or read-order index. */
  resourceVersion: number;
};

export interface ApprovalHistoryIssue {
  kind: "unavailable" | "gc-gap";
  reason: string;
}

export interface RunView {
  state: RunState | null;
  artifacts: Map<string, ArtifactView>;
  evidence: Map<string, EvidenceView>;
  /** target name → latest validation-failure record (cleared or not). */
  validations: Map<string, ValidationView>;
  /** gateId → every gate-visible approval record, in repository read order. */
  approvals: Map<string, ApprovalRecord[]>;
  /** Presentation-only immutable history, ordered by resource version. */
  approvalHistory: Map<string, VersionedApprovalRecord[]>;
  /** History failures/gaps are presentation data and never enter gate/CEL views. */
  approvalHistoryIssues: Map<string, ApprovalHistoryIssue[]>;
}

function decode(content: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(content)) as Record<
    string,
    unknown
  >;
}

async function validSuffixedOverrideApproval(
  slug: string,
  name: string,
  record: ApprovalRecord,
  runEra: string | undefined,
): Promise<boolean> {
  const identity = record.recoveryGrantIdentity;
  if (identity === undefined || record.decision !== "approved") return false;
  const cyclePrefix = "cycle-override:";
  const dispatchPrefix = "dispatch-override:";
  const isCycle = record.gateId.startsWith(cyclePrefix);
  const isDispatch = record.gateId.startsWith(dispatchPrefix);
  if (!isCycle && !isDispatch) return false;
  const scopeStageId = record.gateId.slice(
    isCycle ? cyclePrefix.length : dispatchPrefix.length,
  );
  if (
    runEra === undefined || identity.runEra !== runEra ||
    identity.workItem !== record.workItem ||
    identity.gateId !== record.gateId ||
    identity.failureSignature.trim().length === 0 ||
    scopeStageId.length === 0 ||
    identity.scopeStageId !== scopeStageId ||
    (isDispatch && record.stageId !== identity.scopeStageId) ||
    identity.scopeCycle !== (isDispatch ? record.cycle : null)
  ) return false;
  const digest = await overrideGrantDigest(identity);
  return name === overrideApprovalInstance(slug, record.gateId, digest);
}

export async function loadRunView(
  repo: DataRepositoryLike,
  modelType: unknown,
  modelId: string,
  slug: string,
  expectedWorkItem = slug,
): Promise<RunView> {
  const view: RunView = {
    state: null,
    artifacts: new Map(),
    evidence: new Map(),
    validations: new Map(),
    approvals: new Map(),
    approvalHistory: new Map(),
    approvalHistoryIssues: new Map(),
  };

  const stateName = stateInstance(slug);
  const artifactPrefix = `${ARTIFACT_PREFIX}${slug}-`;
  const evidencePrefix = `${EVIDENCE_PREFIX}${slug}-`;
  const validationPrefix = `${VALIDATION_PREFIX}${slug}-`;
  const approvalPrefix = `${APPROVAL_PREFIX}${slug}-`;

  const entries = await repo.findAllForModel(modelType, modelId);

  // Group versions by instance name.
  const byName = new Map<string, number[]>();
  for (const entry of entries) {
    const versions = byName.get(entry.name) ?? [];
    versions.push(entry.version);
    byName.set(entry.name, versions);
  }

  // Load state first: canonical accumulating-grant identity is run-era scoped.
  const stateVersions = byName.get(stateName);
  if (stateVersions !== undefined) {
    const latestStateVersion = Math.max(...stateVersions);
    const content = await repo.getContent(
      modelType,
      modelId,
      stateName,
      latestStateVersion,
    );
    if (content !== null) view.state = RunStateSchema.parse(decode(content));
  }

  for (const [name, versions] of byName) {
    versions.sort((a, b) => a - b);
    const latestVersion = versions[versions.length - 1];

    if (name === stateName) {
      continue;
    }

    if (name.startsWith(artifactPrefix)) {
      const content = await repo.getContent(
        modelType,
        modelId,
        name,
        latestVersion,
      );
      if (content !== null) {
        const envelope = ArtifactEnvelopeSchema.parse(decode(content));
        view.artifacts.set(envelope.name, {
          latest: envelope,
          version: latestVersion,
        });
      }
      continue;
    }

    if (name.startsWith(evidencePrefix)) {
      const content = await repo.getContent(
        modelType,
        modelId,
        name,
        latestVersion,
      );
      if (content !== null) {
        const envelope = EvidenceEnvelopeSchema.parse(decode(content));
        view.evidence.set(envelope.name, {
          latest: envelope,
          version: latestVersion,
        });
      }
      continue;
    }

    if (name.startsWith(validationPrefix)) {
      const content = await repo.getContent(
        modelType,
        modelId,
        name,
        latestVersion,
      );
      if (content !== null) {
        const envelope = ValidationEnvelopeSchema.parse(decode(content));
        view.validations.set(envelope.target, {
          latest: envelope,
          version: latestVersion,
        });
      }
      continue;
    }

    if (name.startsWith(approvalPrefix)) {
      const records: ApprovalRecord[] = [];
      const isFixedOverride = !name.includes("--grant-") &&
        (name.startsWith(`${approvalPrefix}cycle-override:`) ||
          name.startsWith(`${approvalPrefix}dispatch-override:`));
      // Legacy fixed recovery decisions retain latest-decision semantics.
      // Suffixed grants are immutable logical resources: versions are retries,
      // not additional grants. Ordinary decision history remains gate-visible.
      const visibleVersions = isFixedOverride || name.includes("--grant-")
        ? [latestVersion]
        : versions;
      for (const version of visibleVersions) {
        const content = await repo.getContent(
          modelType,
          modelId,
          name,
          version,
        );
        if (content !== null) {
          const record = ApprovalRecordSchema.parse(decode(content));
          const fixedName = approvalInstance(slug, record.gateId);
          const validName = name === fixedName ||
            (name.startsWith(`${fixedName}--grant-`) &&
              await validSuffixedOverrideApproval(
                slug,
                name,
                record,
                view.state?.startedAt,
              ));
          if (
            validName &&
            record.workItem === expectedWorkItem
          ) records.push(gateVisibleApproval(record));
        }
      }
      if (records.length > 0) {
        const existing = view.approvals.get(records[0].gateId) ?? [];
        view.approvals.set(records[0].gateId, [...existing, ...records]);
      }

      const gateId = records[0]?.gateId ?? name.slice(approvalPrefix.length);
      const issues: ApprovalHistoryIssue[] = [];
      const history: VersionedApprovalRecord[] = [];
      if (repo.listVersions === undefined) {
        issues.push({
          kind: "unavailable",
          reason: "data repository does not support immutable approval history",
        });
      } else {
        try {
          const historyVersions = [
            ...await repo.listVersions(
              modelType,
              modelId,
              name,
            ),
          ].sort((a, b) => a - b);
          if (
            historyVersions.length > 0 &&
            (historyVersions[0] !== 1 ||
              historyVersions.some((v, i) =>
                i > 0 && v !== historyVersions[i - 1] + 1
              ))
          ) {
            issues.push({
              kind: "gc-gap",
              reason:
                "immutable approval history has a detectable retained-version gap",
            });
          }
          for (const version of historyVersions) {
            try {
              const content = await repo.getContent(
                modelType,
                modelId,
                name,
                version,
              );
              if (content === null) {
                issues.push({
                  kind: "unavailable",
                  reason: `approval resource version ${version} is unavailable`,
                });
                continue;
              }
              const record = ApprovalRecordSchema.parse(decode(content));
              const fixedName = approvalInstance(slug, record.gateId);
              const validName = name === fixedName ||
                (name.startsWith(`${fixedName}--grant-`) &&
                  await validSuffixedOverrideApproval(
                    slug,
                    name,
                    record,
                    view.state?.startedAt,
                  ));
              if (
                !validName ||
                record.workItem !== expectedWorkItem
              ) {
                issues.push({
                  kind: "unavailable",
                  reason:
                    `approval resource version ${version} has mismatched gate/work-item identity`,
                });
                continue;
              }
              history.push({ ...record, resourceVersion: version });
            } catch {
              issues.push({
                kind: "unavailable",
                reason:
                  `approval resource version ${version} could not be read or decoded`,
              });
            }
          }
        } catch {
          issues.push({
            kind: "unavailable",
            reason: "immutable approval history enumeration failed",
          });
        }
      }
      if (history.length > 0) {
        const existing = view.approvalHistory.get(gateId) ?? [];
        view.approvalHistory.set(gateId, [...existing, ...history]);
      }
      if (issues.length > 0) {
        const existing = view.approvalHistoryIssues.get(gateId) ?? [];
        view.approvalHistoryIssues.set(gateId, [...existing, ...issues]);
      }
    }
  }

  // Era filtering: a `reset` re-stamps state.startedAt, and records written
  // before it belong to a previous era of this work item's run. They stay in
  // history for audit but are invisible to gates, bindings, and status — a
  // reset run really does start fresh.
  if (view.state !== null) {
    const since = view.state.startedAt;
    for (const [name, artifact] of [...view.artifacts]) {
      if (artifact.latest.recordedAt < since) view.artifacts.delete(name);
    }
    for (const [name, evidence] of [...view.evidence]) {
      if (evidence.latest.recordedAt < since) view.evidence.delete(name);
    }
    for (const [name, validation] of [...view.validations]) {
      if (validation.latest.recordedAt < since) view.validations.delete(name);
    }
    for (const [gateId, records] of [...view.approvals]) {
      const kept = records.filter((r) => r.decidedAt >= since);
      if (kept.length > 0) {
        view.approvals.set(gateId, kept);
      } else {
        view.approvals.delete(gateId);
      }
    }
  }

  return view;
}

/**
 * Overview of every work item this instance has run: latest state per
 * state-<slug> instance.
 */
export async function loadAllRunStates(
  repo: DataRepositoryLike,
  modelType: unknown,
  modelId: string,
): Promise<RunState[]> {
  const entries = await repo.findAllForModel(modelType, modelId);
  const latestByName = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.name.startsWith(STATE_PREFIX)) continue;
    const current = latestByName.get(entry.name) ?? 0;
    if (entry.version > current) latestByName.set(entry.name, entry.version);
  }
  const states: RunState[] = [];
  for (const [name, version] of latestByName) {
    const content = await repo.getContent(modelType, modelId, name, version);
    if (content !== null) {
      states.push(RunStateSchema.parse(decode(content)));
    }
  }
  states.sort((a, b) => a.workItem.localeCompare(b.workItem));
  return states;
}

/**
 * The live (uncleared) validation-failure record for a target, if one is
 * open. A cleared record (a later attempt succeeded) reads as no failure.
 */
export function liveValidation(
  view: RunView,
  target: string,
): ValidationView | undefined {
  const record = view.validations.get(target);
  return record !== undefined && !record.latest.cleared ? record : undefined;
}

/** Current cycle (entry count) of the run's current stage. */
export function currentCycle(state: RunState): number {
  return state.cycles[state.stageId] ?? 1;
}

/** Entry count for an arbitrary stage (0 when never entered). */
export function entriesInto(state: RunState, stageId: string): number {
  return state.cycles[stageId] ?? 0;
}

/**
 * Dispatch attempts recorded for a stage during the given cycle (its current
 * entry). Returns 0 when the stage was never dispatched this cycle — a stale
 * counter from an earlier entry does not carry over.
 */
export function dispatchAttempts(
  state: RunState,
  stageId: string,
  cycle: number,
): number {
  const record = state.dispatches?.[stageId];
  return record !== undefined && record.cycle === cycle ? record.count : 0;
}
