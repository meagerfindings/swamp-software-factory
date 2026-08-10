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
  FactoryArguments,
  GateSpec,
  TransitionSpec,
} from "./definition_schema.ts";
import { celName, findArtifactSpec } from "./definition_schema.ts";
import type { FindingsPayload } from "./artifact_schema.ts";
import type {
  ApprovalRecord,
  DataRepositoryLike,
  RunState,
  RunView,
} from "./run_data.ts";
import { currentCycle, entriesInto } from "./run_data.ts";
import type { SubjectRecordIdentity } from "./approval_subject.ts";
import { computeApprovalSubject, describeSubject } from "./approval_subject.ts";

// ---------------------------------------------------------------------------
// Gate evaluation. Gates are veto: every gate on a transition must pass for
// `advance`. Failure reasons are agent-facing — they are the error message
// that steers the driver, so they say what is missing and how to satisfy it.
// ---------------------------------------------------------------------------

/** Minimal surface of the CEL environment swamp hands to extensions. */
export interface CelEnvironmentLike {
  evaluate(expression: string, context: Record<string, unknown>): unknown;
}

export interface GateContext {
  args: FactoryArguments;
  state: RunState;
  view: RunView;
  /** The work item this evaluation is scoped to. */
  workItem: string;
  /** The work item's instance-name slug (see run_data.workItemSlug). */
  workItemSlug?: string;
  /** Injectable clock for tests. */
  now: Date;
  /**
   * This factory instance's definition name. Used to scope workflow
   * step-output verification to data written into this instance — without
   * it, parallel factories sharing one workflow could satisfy each other's
   * gates.
   */
  selfName?: string;
  /**
   * Definition identity, folded into subject-bound approval digests (unless a
   * gate sets `includeDefinition: false`) so a mid-run definition edit
   * invalidates decisions taken under the previous rules. Absent in harnesses
   * with no definition; the digest then simply omits the field, consistently
   * on both the recording and the checking side.
   */
  definition?: { name: string; version: number };
  createCelEnvironment?: () => CelEnvironmentLike;
  queryData?: (
    predicate: string,
    select?: string,
  ) => Promise<unknown[]>;
  dataRepository?: DataRepositoryLike;
}

export interface GateResult {
  gate: GateSpec;
  pass: boolean;
  reasons: string[];
}

export interface TransitionGateResults {
  pass: boolean;
  results: GateResult[];
}

export async function evaluateTransitionGates(
  transition: TransitionSpec,
  ctx: GateContext,
): Promise<TransitionGateResults> {
  const results: GateResult[] = [];
  for (const gate of transition.gates ?? []) {
    results.push(await evaluateGate(gate, ctx));
  }
  return { pass: results.every((r) => r.pass), results };
}

export function evaluateGate(
  gate: GateSpec,
  ctx: GateContext,
): Promise<GateResult> {
  switch (gate.type) {
    case "artifact-exists":
      return Promise.resolve(artifactExists(gate, ctx));
    case "artifact-fresh":
      return Promise.resolve(artifactFresh(gate, ctx));
    case "findings-clear":
      return Promise.resolve(findingsClear(gate, ctx));
    case "human-approval":
      return humanApproval(gate, ctx);
    case "evidence-recorded":
      return Promise.resolve(evidenceRecorded(gate, ctx));
    case "cooldown":
      return Promise.resolve(cooldown(gate, ctx));
    case "max-cycles":
      return Promise.resolve(maxCycles(gate, ctx));
    case "cel":
      return Promise.resolve(celGate(gate, ctx));
    case "workflow-succeeded":
      return workflowSucceeded(gate, ctx);
  }
}

type GateOf<T extends GateSpec["type"]> = Extract<GateSpec, { type: T }>;

function pass(gate: GateSpec): GateResult {
  return { gate, pass: true, reasons: [] };
}

function fail(gate: GateSpec, ...reasons: string[]): GateResult {
  return { gate, pass: false, reasons };
}

function artifactExists(
  gate: GateOf<"artifact-exists">,
  ctx: GateContext,
): GateResult {
  const name = gate.config.artifact;
  if (ctx.view.artifacts.has(name)) return pass(gate);
  return fail(
    gate,
    `artifact '${name}' has not been recorded — record it with record_artifact`,
  );
}

function artifactFresh(
  gate: GateOf<"artifact-fresh">,
  ctx: GateContext,
): GateResult {
  const name = gate.config.artifact;
  const artifact = ctx.view.artifacts.get(name);
  if (artifact === undefined) {
    return fail(
      gate,
      `artifact '${name}' has not been recorded — record it with record_artifact`,
    );
  }
  const spec = findArtifactSpec(ctx.args, name)?.spec;
  const subjectName = spec?.reviews;
  if (subjectName === undefined) {
    return fail(
      gate,
      `artifact '${name}' declares no reviews: subject — artifact-fresh cannot apply (fix the definition)`,
    );
  }
  const subject = ctx.view.artifacts.get(subjectName);
  if (subject === undefined) {
    return fail(
      gate,
      `subject artifact '${subjectName}' has not been recorded`,
    );
  }
  const reasons: string[] = [];
  if (artifact.latest.subjectVersion !== subject.version) {
    reasons.push(
      `'${name}' reviews '${subjectName}' v${
        artifact.latest.subjectVersion ?? "?"
      } but the current version is v${subject.version} — re-record '${name}' against the current subject`,
    );
  }
  if (gate.config.recordedThisCycle === true) {
    const cycle = currentCycle(ctx.state);
    if (
      artifact.latest.stageId !== ctx.state.stageId ||
      artifact.latest.cycle !== cycle
    ) {
      reasons.push(
        `'${name}' was recorded in stage '${artifact.latest.stageId}' cycle ${artifact.latest.cycle}, not during the current entry into '${ctx.state.stageId}' (cycle ${cycle}) — re-record it this cycle`,
      );
    }
  }
  if (reasons.length > 0) return fail(gate, ...reasons);
  return pass(gate);
}

function findingsClear(
  gate: GateOf<"findings-clear">,
  ctx: GateContext,
): GateResult {
  const name = gate.config.artifact;
  const artifact = ctx.view.artifacts.get(name);
  if (artifact === undefined) {
    return fail(
      gate,
      `findings artifact '${name}' has not been recorded`,
    );
  }
  const payload = artifact.latest.payload as Partial<FindingsPayload>;
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const blocking = new Set<string>(gate.config.blocking);
  const unresolved = findings.filter(
    (f) => f.resolved !== true && blocking.has(f.severity),
  );
  if (unresolved.length > 0) {
    const ids = unresolved.map((f) => `${f.id} (${f.severity})`).join(", ");
    return fail(
      gate,
      `${unresolved.length} unresolved blocking finding(s) in '${name}': ${ids} — resolve them with resolve_findings or rework`,
    );
  }
  return pass(gate);
}

async function humanApproval(
  gate: GateOf<"human-approval">,
  ctx: GateContext,
): Promise<GateResult> {
  const id = gate.config.id;
  const min = gate.config.minApprovals ?? 1;
  const cycle = currentCycle(ctx.state);
  const records = (ctx.view.approvals.get(id) ?? []).filter(
    (r) => r.stageId === ctx.state.stageId && r.cycle === cycle,
  );

  const subjectSpec = gate.config.subject;
  if (subjectSpec === undefined) {
    // Unbound gate: original semantics, unchanged. Bound decisions recorded
    // against it (if a definition dropped its subject config mid-run) still
    // count — the human said yes to at least as much as this gate asks.
    return unboundApproval(gate, id, min, records, cycle, ctx);
  }

  // Subject-bound gate. Recompute the current subject from recorded data and
  // require an exact digest match. Fail closed: anything we cannot verify —
  // an incomplete subject, an unbound decision, a stale digest — blocks.
  const current = await computeApprovalSubject({
    gateId: id,
    subject: subjectSpec,
    workItem: ctx.workItem,
    state: ctx.state,
    view: ctx.view,
    definition: ctx.definition,
  });

  if (current.missing.length > 0) {
    const names = current.missing
      .map((m) => `${m.kind} '${m.name}'`)
      .join(", ");
    return fail(
      gate,
      `human approval '${id}' binds to ${
        describeSubject(subjectSpec)
      }, but ${names} has not been recorded — record the subject before seeking approval`,
    );
  }

  // A rejection blocks only the subject it was a rejection of. Reworking the
  // subject (a new plan version, fresh evidence) produces a different digest,
  // which clears the block without needing the rejection to be withdrawn —
  // and leaves the old rejection standing as audit of that exact artifact.
  const matching = records.filter(
    (r) => r.subjectStatus === "bound" && r.subject?.digest === current.digest,
  );
  const rejection = latestMatchingRejection(matching, current.digest);
  if (rejection !== undefined) {
    return fail(
      gate,
      `'${id}' was rejected by ${rejection.actor}${
        rejection.note !== undefined ? `: ${rejection.note}` : ""
      } for this exact subject (${
        shortDigest(current.digest)
      }) — change the subject (re-record ${
        describeSubject(subjectSpec)
      }) and seek approval again`,
    );
  }

  const approved = matching.filter((r) => r.decision === "approved").length;
  if (approved >= min) return pass(gate);

  // Nothing binding is in force. Say precisely why, because the difference
  // between "nobody approved" and "someone approved something else" is the
  // whole point of this gate.
  const stale = records.filter(
    (r) =>
      r.decision === "approved" && r.subjectStatus === "bound" &&
      r.subject?.digest !== current.digest,
  );
  const unbound = records.filter(
    (r) => r.decision === "approved" && r.subjectStatus !== "bound",
  );
  const reasons: string[] = [
    `awaiting human approval '${id}' (${approved}/${min}) bound to ${
      describeSubject(subjectSpec)
    } for stage '${ctx.state.stageId}' cycle ${cycle} — current subject ${
      shortDigest(current.digest)
    }; a human must run approve with gateId=${id}`,
  ];
  if (stale.length > 0) {
    const detail = stale
      .map((r) =>
        `${r.actor} approved ${shortDigest(r.subject?.digest ?? "?")}`
      )
      .join("; ")
      .concat(
        ` — the subject changed since (${
          explainDrift(stale[stale.length - 1], current)
        })`,
      );
    reasons.push(
      `${stale.length} stale approval(s) do not match the current subject: ${detail}`,
    );
  }
  if (unbound.length > 0) {
    reasons.push(
      `${unbound.length} approval(s) for '${id}' carry no subject binding (recorded by ${
        unbound.map((r) => r.actor).join(", ")
      }) — they predate this gate's subject config and cannot authorize it; re-approve to bind`,
    );
  }
  return fail(gate, ...reasons);
}

/** The most recent rejection that remains in force for an exact subject. */
export function latestMatchingRejection(
  records: ApprovalRecord[],
  digest: string,
): ApprovalRecord | undefined {
  return records.findLast((r) =>
    r.decision === "rejected" && r.subjectStatus === "bound" &&
    r.subject?.digest === digest
  );
}

function unboundApproval(
  gate: GateOf<"human-approval">,
  id: string,
  min: number,
  records: ApprovalRecord[],
  cycle: number,
  ctx: GateContext,
): GateResult {
  const latest = records[records.length - 1];
  if (latest !== undefined && latest.decision === "rejected") {
    return fail(
      gate,
      `'${id}' was rejected by ${latest.actor}${
        latest.note !== undefined ? `: ${latest.note}` : ""
      } — address the feedback, then seek approval again`,
    );
  }
  const approved = records.filter((r) => r.decision === "approved").length;
  if (approved < min) {
    return fail(
      gate,
      `awaiting human approval '${id}' (${approved}/${min}) for stage '${ctx.state.stageId}' cycle ${cycle} — a human must run approve with gateId=${id}`,
    );
  }
  return pass(gate);
}

/** First 12 hex chars — enough to identify a subject in an error message. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

/**
 * Which selected record moved between an approved subject and the current one.
 * Turns "digest mismatch" into "the plan was re-recorded", which is what the
 * driver and the human actually need to act on.
 */
function explainDrift(
  approval: ApprovalRecord,
  current: { manifest: { records: SubjectRecordIdentity[] } },
): string {
  const before = approval.subject?.manifest as
    | { records?: SubjectRecordIdentity[] }
    | undefined;
  const previous = new Map(
    (before?.records ?? []).map((r) => [`${r.kind}:${r.name}`, r]),
  );
  const changed: string[] = [];
  for (const record of current.manifest.records) {
    const key = `${record.kind}:${record.name}`;
    const old = previous.get(key);
    if (old === undefined) {
      changed.push(`${record.kind} '${record.name}' was not in the approval`);
      continue;
    }
    if (old.version !== record.version) {
      changed.push(
        `${record.kind} '${record.name}' v${old.version} → v${record.version}`,
      );
    } else if (old.payloadDigest !== record.payloadDigest) {
      changed.push(`${record.kind} '${record.name}' content changed`);
    } else if (old.recordedAt !== record.recordedAt) {
      changed.push(`${record.kind} '${record.name}' was re-recorded`);
    }
    previous.delete(key);
  }
  for (const [, record] of previous) {
    changed.push(`${record.kind} '${record.name}' is no longer recorded`);
  }
  return changed.join("; ") || "run or definition identity changed";
}

function evidenceRecorded(
  gate: GateOf<"evidence-recorded">,
  ctx: GateContext,
): GateResult {
  const name = gate.config.name;
  const evidence = ctx.view.evidence.get(name);
  if (evidence === undefined) {
    return fail(
      gate,
      `evidence '${name}' has not been recorded — record it with record_evidence`,
    );
  }
  const cycle = currentCycle(ctx.state);
  if (
    evidence.latest.stageId !== ctx.state.stageId ||
    evidence.latest.cycle !== cycle
  ) {
    return fail(
      gate,
      `evidence '${name}' was recorded in stage '${evidence.latest.stageId}' cycle ${evidence.latest.cycle}, not during the current entry into '${ctx.state.stageId}' (cycle ${cycle}) — record fresh evidence`,
    );
  }
  for (
    const [field, expected] of Object.entries(gate.config.requireField ?? {})
  ) {
    const actual = fieldAtPath(evidence.latest.payload, field);
    if (actual !== expected) {
      return fail(
        gate,
        `evidence '${name}' field '${field}' is ${
          JSON.stringify(actual)
        }, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  return pass(gate);
}

function fieldAtPath(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function cooldown(
  gate: GateOf<"cooldown">,
  ctx: GateContext,
): GateResult {
  let recordedAt: string | undefined;
  let what: string;
  if (gate.config.afterEvidence !== undefined) {
    what = `evidence '${gate.config.afterEvidence}'`;
    recordedAt = ctx.view.evidence.get(gate.config.afterEvidence)?.latest
      .recordedAt;
  } else {
    what = `artifact '${gate.config.afterArtifact}'`;
    recordedAt = gate.config.afterArtifact !== undefined
      ? ctx.view.artifacts.get(gate.config.afterArtifact)?.latest.recordedAt
      : undefined;
  }
  if (recordedAt === undefined) {
    return fail(
      gate,
      `${what} has not been recorded — nothing to cool down from`,
    );
  }
  const elapsed = (ctx.now.getTime() - new Date(recordedAt).getTime()) / 1000;
  if (elapsed < gate.config.seconds) {
    const remaining = Math.ceil(gate.config.seconds - elapsed);
    return fail(
      gate,
      `${what} was recorded ${
        Math.floor(elapsed)
      }s ago — wait ${remaining}s more (${gate.config.seconds}s cooldown)`,
    );
  }
  return pass(gate);
}

function maxCycles(
  gate: GateOf<"max-cycles">,
  ctx: GateContext,
): GateResult {
  const entries = entriesInto(ctx.state, gate.config.stage);
  const under = entries < gate.config.limit;
  const wantUnder = gate.config.invert !== true;
  if (under === wantUnder) return pass(gate);
  if (wantUnder) {
    return fail(
      gate,
      `stage '${gate.config.stage}' has been entered ${entries} time(s), at or over the limit of ${gate.config.limit}`,
    );
  }
  return fail(
    gate,
    `stage '${gate.config.stage}' has been entered ${entries} time(s), under the threshold of ${gate.config.limit}`,
  );
}

/**
 * Build the materialized run-data context for CEL gates: latest artifact
 * and evidence payloads under snake-cased names, plus state, approvals,
 * and the work item.
 */
export function buildCelContext(
  ctx: GateContext,
): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {};
  for (const [name, view] of ctx.view.artifacts) {
    artifacts[celName(name)] = view.latest.payload;
  }
  const evidence: Record<string, unknown> = {};
  for (const [name, view] of ctx.view.evidence) {
    evidence[celName(name)] = view.latest.payload;
  }
  const approvals: Record<string, unknown> = {};
  for (const [gateId, records] of ctx.view.approvals) {
    approvals[celName(gateId.replaceAll(":", "_"))] = records;
  }
  return {
    artifacts,
    evidence,
    approvals,
    state: {
      stageId: ctx.state.stageId,
      cycles: ctx.state.cycles,
      status: ctx.state.status,
    },
    workItem: ctx.workItem,
  };
}

function celGate(
  gate: GateOf<"cel">,
  ctx: GateContext,
): GateResult {
  if (ctx.createCelEnvironment === undefined) {
    return fail(gate, "CEL evaluator unavailable in this execution context");
  }
  let result: unknown;
  try {
    const env = ctx.createCelEnvironment();
    result = env.evaluate(gate.config.expr, buildCelContext(ctx));
  } catch (error) {
    return fail(
      gate,
      `CEL gate evaluation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (result === true) return pass(gate);
  const message = gate.config.message ??
    `CEL gate [${gate.config.expr}] evaluated to ${JSON.stringify(result)}`;
  return fail(gate, message);
}

// ---------------------------------------------------------------------------
// workflow-succeeded: verify against the platform's own workflow run
// records (report-swamp-workflow-summary-json), not driver attestation.
//
// Every run of the named workflow is considered, newest first. The gate
// passes when ANY run qualifies: it succeeded, it did not predate the
// current stage entry, and it wrote every required step output into this
// work item's run data. Judging only one "latest" record let an unrelated
// failed sibling run (a parallel work item, a negative test) shadow a
// genuinely qualifying run and park the work item.
// ---------------------------------------------------------------------------

const WORKFLOW_SUMMARY_NAME = "report-swamp-workflow-summary-json";

interface WorkflowSummary {
  status: string;
  workflowName: string;
  workflowRunId: string;
  failed?: number;
  failures?: unknown[];
}

interface WorkflowRunCandidate {
  summary: WorkflowSummary;
  createdAt: string | undefined;
}

async function workflowSucceeded(
  gate: GateOf<"workflow-succeeded">,
  ctx: GateContext,
): Promise<GateResult> {
  if (ctx.queryData === undefined || ctx.dataRepository === undefined) {
    return fail(
      gate,
      "workflow run records unavailable in this execution context",
    );
  }
  // Summary reports are versioned per WORKFLOW, not per run: each reported
  // run writes a new version of the same record, so the default (latest-only)
  // query surfaces exactly one run per workflow — whichever reported last.
  // Sibling work items sharing a workflow overwrite each other's summaries.
  // Query the version history explicitly so an overwritten qualifying run is
  // still visible.
  let records: unknown[];
  try {
    const latest = await ctx.queryData(
      `name == "${WORKFLOW_SUMMARY_NAME}" && isLatest == true && modelType == "workflow"`,
    );
    const historical = await ctx.queryData(
      `name == "${WORKFLOW_SUMMARY_NAME}" && isLatest == false && modelType == "workflow"`,
    );
    records = [...latest, ...historical];
  } catch (error) {
    return fail(
      gate,
      `workflow run query failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const candidates: WorkflowRunCandidate[] = [];
  const seenRunIds = new Set<string>();
  for (const record of records) {
    const rec = record as Record<string, unknown>;
    const ownerRef = rec.ownerRef;
    if (typeof ownerRef !== "string") continue;
    let summary: WorkflowSummary | null = null;
    const inline = rec.content;
    if (typeof inline === "string" && inline.length > 0) {
      try {
        summary = JSON.parse(inline) as WorkflowSummary;
      } catch {
        summary = null;
      }
    } else if (typeof inline === "object" && inline !== null) {
      // Some query surfaces return the JSON content already parsed.
      summary = inline as WorkflowSummary;
    }
    if (summary === null && rec.isLatest !== false) {
      // Content fetch by name resolves to the latest version only, so this
      // fallback is meaningless for historical records.
      const content = await ctx.dataRepository.getContent(
        "workflow",
        ownerRef,
        WORKFLOW_SUMMARY_NAME,
      );
      if (content === null) continue;
      try {
        summary = JSON.parse(
          new TextDecoder().decode(content),
        ) as WorkflowSummary;
      } catch {
        continue;
      }
    }
    if (summary === null) continue;
    if (summary.workflowName !== gate.config.workflow) continue;
    if (typeof summary.workflowRunId === "string") {
      if (seenRunIds.has(summary.workflowRunId)) continue;
      seenRunIds.add(summary.workflowRunId);
    }

    candidates.push({
      summary,
      createdAt: typeof rec.createdAt === "string" ? rec.createdAt : undefined,
    });
  }

  if (candidates.length === 0) {
    return fail(
      gate,
      `no run record found for workflow '${gate.config.workflow}' — trigger the workflow first`,
    );
  }

  // Newest first: a pass prefers fresh evidence, and a fail reports the
  // most recent attempt's disqualification.
  candidates.sort((a, b) =>
    (a.createdAt === undefined ? 0 : Date.parse(a.createdAt)) <
        (b.createdAt === undefined ? 0 : Date.parse(b.createdAt))
      ? 1
      : -1
  );

  const disqualifications: string[] = [];
  for (const candidate of candidates) {
    const reason = await disqualifyWorkflowRun(gate, ctx, candidate);
    if (reason === null) return pass(gate);
    disqualifications.push(reason);
  }

  const considered = candidates.length > 1
    ? ` (${candidates.length} runs of this workflow were considered; none qualified)`
    : "";
  return fail(gate, `${disqualifications[0]}${considered}`);
}

/**
 * Judge one run of the gate's workflow. Returns null when the run
 * qualifies, otherwise the human-readable disqualification.
 */
async function disqualifyWorkflowRun(
  gate: GateOf<"workflow-succeeded">,
  ctx: GateContext,
  candidate: WorkflowRunCandidate,
): Promise<string | null> {
  const { summary, createdAt } = candidate;

  if (summary.status !== "succeeded") {
    return `run of workflow '${gate.config.workflow}' (${summary.workflowRunId}) has status '${summary.status}'${
      summary.failed !== undefined && summary.failed > 0
        ? ` with ${summary.failed} failed step(s)`
        : ""
    }`;
  }

  if (createdAt !== undefined) {
    const ranAt = new Date(createdAt).getTime();
    const enteredAt = new Date(ctx.state.enteredAt).getTime();
    if (ranAt < enteredAt) {
      return `run of workflow '${gate.config.workflow}' (${summary.workflowRunId}) predates the current entry into stage '${ctx.state.stageId}' — run it again for this cycle`;
    }
  }

  for (const required of gate.config.requireStepOutputs ?? []) {
    // Scope to this run's own data: in parallel use, sibling runs share
    // the workflow, and an unscoped match would accept their outputs.
    // Required names are logical ("evidence-test-run"); translate to the
    // work item's physical instance name.
    const physical = physicalStepOutput(required, ctx.workItemSlug);
    const selfClause = ctx.selfName !== undefined
      ? ` && modelName == "${ctx.selfName}"`
      : "";
    let outputs: unknown[];
    if (ctx.queryData === undefined) {
      return "workflow run records unavailable in this execution context";
    }
    try {
      outputs = await ctx.queryData(
        `workflowRunId == "${summary.workflowRunId}" && name == "${physical}"${selfClause}`,
      );
    } catch (error) {
      return `step-output query failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (outputs.length === 0) {
      return `verified run ${summary.workflowRunId} did not write required output '${required}'${
        ctx.selfName !== undefined ? ` into run '${ctx.selfName}'` : ""
      }`;
    }
  }

  return null;
}

/**
 * Translate a logical step-output name to the work item's physical data
 * instance name (artifact-/evidence-<slug>-<name>).
 */
export function physicalStepOutput(
  required: string,
  slug: string | undefined,
): string {
  if (slug === undefined) return required;
  if (required.startsWith("artifact-")) {
    return `artifact-${slug}-${required.slice("artifact-".length)}`;
  }
  if (required.startsWith("evidence-")) {
    return `evidence-${slug}-${required.slice("evidence-".length)}`;
  }
  return required;
}
