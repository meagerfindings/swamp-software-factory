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

/**
 * A generic, definition-driven state machine for software delivery work items.
 *
 * @module
 */

import { z } from "npm:zod@4.3.6";
import type {
  ApprovalSubjectSpec,
  FactoryArguments,
  StageSpec,
  TransitionSpec,
  WorkSpec,
} from "./_lib/definition_schema.ts";
import {
  allApprovalGateIds,
  celName,
  CYCLE_OVERRIDE_PREFIX,
  DISPATCH_OVERRIDE_PREFIX,
  FactoryArgumentsSchema,
  findArtifactSpec,
  findStage,
  initialStage,
  isGlobalTransition,
  maxCyclesFor,
  maxDispatchesFor,
  PlatformArgumentsSchema,
  transitionsFrom,
} from "./_lib/definition_schema.ts";
import {
  formatIssues,
  validateArtifactPayload,
  validateDeclaredPayload,
  validateOutcomePayload,
} from "./_lib/artifact_schema.ts";
import { validateGraph } from "./_lib/graph.ts";
import type {
  ApprovalRecord,
  ArtifactEnvelope,
  DataRepositoryLike,
  RunState,
  RunView,
  ValidationEnvelope,
} from "./_lib/run_data.ts";
import {
  approvalInstance,
  ApprovalRecordSchema,
  ArtifactEnvelopeSchema,
  artifactInstance,
  AttemptLeaseSchema,
  currentCycle,
  dispatchAttempts,
  entriesInto,
  EvidenceEnvelopeSchema,
  evidenceInstance,
  JournalEntrySchema,
  journalInstance,
  liveValidation,
  loadAllRunStates,
  loadRunView,
  overrideApprovalInstance,
  overrideGrantDigest,
  OVERVIEW_SLUG,
  RunStateSchema,
  stateInstance,
  StatusEnvelopeSchema,
  statusInstance,
  ValidationEnvelopeSchema,
  validationInstance,
  workItemSlug,
} from "./_lib/run_data.ts";
import type { CelEnvironmentLike, GateContext } from "./_lib/gates.ts";
import {
  evaluateTransitionGates,
  latestMatchingRejection,
  shortDigest,
} from "./_lib/gates.ts";
import type { ApprovalSubject } from "./_lib/approval_subject.ts";
import {
  approvalGatesInScope,
  canonicalJson,
  computeApprovalSubject,
  computeApprovalSubjectContract,
  describeSubject,
  parseApprovalSubjectManifest,
  resolveSubjectSpec,
  sha256Hex,
} from "./_lib/approval_subject.ts";
import {
  AuthorityChallengeEventSchema,
  mintAuthorityChallengeEvent,
  validateAuthorityChallengeEvent,
} from "./_lib/authority_challenge.ts";
import type { BindingEnvironmentLike } from "./_lib/bindings.ts";
import { prepareBindingEnvironment, resolveBindings } from "./_lib/bindings.ts";
import { renderMermaid, renderTables } from "./_lib/mermaid.ts";
import {
  buildWorkItemSummary,
  queryRunDataReader,
  repositoryRunDataReader,
  reviewsFromStages,
} from "./_lib/summary.ts";

// ---------------------------------------------------------------------------
// Execution context (structural slice of swamp's MethodContext)
// ---------------------------------------------------------------------------

interface Logger {
  info(message: string, props: Record<string, unknown>): void;
  warning(message: string, props: Record<string, unknown>): void;
}

interface DefinitionRepositoryLike {
  findById(
    modelType: unknown,
    id: string,
  ): Promise<
    | {
      name: string;
      version?: number;
      globalArguments: Record<string, unknown>;
    }
    | null
  >;
}

interface Ctx {
  globalArgs: Record<string, unknown>;
  modelType: unknown;
  modelId: string;
  logger: Logger;
  definition?: {
    id: string;
    name: string;
    version: number;
    tags: Record<string, string>;
  };
  definitionRepository?: DefinitionRepositoryLike;
  dataRepository: DataRepositoryLike;
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string; version?: number }>;
  createCelEnvironment?: () => CelEnvironmentLike & BindingEnvironmentLike;
  queryData?: (predicate: string, select?: string) => Promise<unknown[]>;
  /**
   * Production check contexts carry the query service rather than the
   * executor-derived queryData binding; the engine accepts either.
   */
  dataQueryService?: {
    query(
      predicate: string,
      options?: { select?: string },
    ): Promise<unknown[]>;
  };
}

function queryDataFrom(context: Ctx): Ctx["queryData"] {
  if (context.queryData !== undefined) return context.queryData;
  const service = context.dataQueryService;
  if (service === undefined) return undefined;
  return (predicate, select) => service.query(predicate, { select });
}

type CheckCtx = Ctx & {
  methodName: string;
  unresolvedMethodArgs?: Record<string, unknown>;
};

interface CheckResult {
  pass: boolean;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

/**
 * Load the factory definition from the raw definition file (via the
 * definition repository) rather than context.globalArgs: the platform's
 * globalArgs proxy throws on access to fields containing unresolved
 * `${{ }}` expressions, and stage config legitimately embeds them as
 * run-data bindings. Falls back to context.globalArgs when no repository
 * is available (tests, simple harnesses).
 */
async function loadFactoryArgs(
  context: Pick<
    Ctx,
    "globalArgs" | "modelType" | "modelId" | "definitionRepository"
  >,
): Promise<{ args: FactoryArguments; definitionName: string }> {
  let raw: Record<string, unknown> | undefined;
  let definitionName = "";
  if (context.definitionRepository !== undefined) {
    const definition = await context.definitionRepository.findById(
      context.modelType,
      context.modelId,
    );
    if (definition !== null) {
      raw = definition.globalArguments;
      definitionName = definition.name;
    }
  }
  if (raw === undefined) {
    raw = context.globalArgs;
  }
  const parsed = FactoryArgumentsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      "Invalid factory definition globalArguments:\n  " +
        formatIssues(parsed.error).join("\n  "),
    );
  }
  return { args: parsed.data, definitionName };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

async function definitionHash(args: FactoryArguments): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(args)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Load one work item's run view on this instance. */
async function viewFor(
  context: Ctx,
  slug: string,
  workItem: string,
): Promise<RunView> {
  const current = await loadRunView(
    context.dataRepository,
    context.modelType,
    context.modelId,
    slug,
    workItem,
  );
  // The package was renamed from the upstream @swamp collective to the
  // user-owned @mgreten collective. Read legacy run data when a caller is
  // operating on an existing run, then write new versions under the current
  // type. Current records win by name, so an explicit migration can gradually
  // adopt the run without losing old artifacts, evidence, or approvals.
  if (context.modelType !== "@mgreten/software-factory") return current;
  const legacy = await loadRunView(
    context.dataRepository,
    "@swamp/software-factory",
    context.modelId,
    slug,
    workItem,
  );
  if (legacy.state === null) return current;
  return {
    state: current.state ?? legacy.state,
    artifacts: new Map([...legacy.artifacts, ...current.artifacts]),
    evidence: new Map([...legacy.evidence, ...current.evidence]),
    validations: new Map([...legacy.validations, ...current.validations]),
    approvals: new Map([...legacy.approvals, ...current.approvals]),
    approvalHistory: new Map([
      ...legacy.approvalHistory,
      ...current.approvalHistory,
    ]),
    approvalHistoryIssues: new Map([
      ...legacy.approvalHistoryIssues,
      ...current.approvalHistoryIssues,
    ]),
  };
}

function requireState(view: RunView, workItem: string): RunState {
  if (view.state === null) {
    throw new Error(
      `No run for work item '${workItem}'. Run 'start' with workItem=${workItem} first.`,
    );
  }
  return view.state;
}

function requireActive(state: RunState): void {
  if (state.status === "terminal") {
    throw new Error(
      `Run for work item '${state.workItem}' is terminal (stage '${state.stageId}'). ` +
        "Use 'reset' to start it over.",
    );
  }
}

function requireCurrentStage(
  args: FactoryArguments,
  state: RunState,
): StageSpec {
  const stage = findStage(args, state.stageId);
  if (stage === undefined) {
    throw new Error(
      `Current stage '${state.stageId}' no longer exists in the definition. ` +
        "The definition changed incompatibly mid-run — restore the stage or 'reset'.",
    );
  }
  return stage;
}

function resolveTransition(
  args: FactoryArguments,
  stage: StageSpec,
  name: string,
): TransitionSpec {
  const available = transitionsFrom(args, stage);
  const transition = available.find((t) => t.name === name);
  if (transition === undefined) {
    const names = available.map((t) => t.name).join(", ") || "(none)";
    throw new Error(
      `Transition '${name}' is not available from stage '${stage.id}'. Available: ${names}`,
    );
  }
  return transition;
}

function approvedOverrides(view: RunView, stageId: string): number {
  const records = view.approvals.get(`${CYCLE_OVERRIDE_PREFIX}${stageId}`) ??
    [];
  return records.filter((r) => r.decision === "approved").length;
}

/**
 * Extra dispatches a human has granted for the CURRENT entry into a stage.
 * Unlike cycle overrides (which count cumulatively against cumulative
 * entries), a dispatch override is scoped to the (stage, cycle) at which it
 * was approved: a grant spent — or never used — in one entry must not
 * silently expand every later entry's budget.
 */
function approvedDispatchOverrides(
  view: RunView,
  stageId: string,
  cycle: number,
): number {
  const records = view.approvals.get(`${DISPATCH_OVERRIDE_PREFIX}${stageId}`) ??
    [];
  return records.filter((r) =>
    r.decision === "approved" && r.stageId === stageId && r.cycle === cycle
  ).length;
}

interface CycleLimit {
  entries: number;
  limit: number;
  overrides: number;
  allowed: boolean;
}

function cycleLimitFor(
  args: FactoryArguments,
  view: RunView,
  state: RunState,
  targetStageId: string,
): CycleLimit {
  const target = findStage(args, targetStageId);
  const limit = target !== undefined ? maxCyclesFor(target) : 0;
  const entries = entriesInto(state, targetStageId);
  const overrides = approvedOverrides(view, targetStageId);
  return {
    entries,
    limit,
    overrides,
    allowed: entries < limit + overrides,
  };
}

function cycleLimitError(targetStageId: string, limit: CycleLimit): string {
  return `Stage '${targetStageId}' has been entered ${limit.entries} time(s) ` +
    `(limit ${limit.limit}${
      limit.overrides > 0 ? ` + ${limit.overrides} override(s)` : ""
    }). A human must grant one more entry with: ` +
    `approve gateId=${CYCLE_OVERRIDE_PREFIX}${targetStageId} — or take an escalation/abort transition.`;
}

function stageNotExecutedError(stageId: string, workItem: string): string {
  return `Stage '${stageId}' has no recorded execution this cycle. Call ` +
    `record_dispatch (workItem=${workItem}) before advancing — the stage's ` +
    `work must run through the factory so it cannot be skipped.`;
}

/** Whether advancing this transition requires a dispatch record first: a
 * work-bearing stage leaving by one of its own (non-global) transitions. */
function requiresDispatch(
  args: FactoryArguments,
  stage: StageSpec,
  transitionName: string,
): boolean {
  return stage.work !== undefined &&
    !isGlobalTransition(args, transitionName) &&
    (stage.transitions ?? []).some((t) => t.name === transitionName);
}

/**
 * Definition identity for approval-subject digests. Both fields must be
 * present to be meaningful — a name without a version (or vice versa) would
 * make the digest depend on how much the harness happened to supply.
 */
function definitionIdentity(
  context: Ctx,
): { name: string; version: number } | undefined {
  const definition = context.definition;
  if (definition === undefined) return undefined;
  return { name: definition.name, version: definition.version };
}

type ChallengeExpected = Parameters<
  typeof validateAuthorityChallengeEvent
>[1];

export async function persistAuthorityChallenge(
  context: Ctx,
  event: z.infer<typeof AuthorityChallengeEventSchema>,
  expected: ChallengeExpected,
): Promise<{ name: string; version?: number }> {
  const repository = context.dataRepository;
  if (repository.listVersions === undefined) {
    throw new Error(
      "Cannot persist authority challenge without exact version inspection",
    );
  }
  const [discovered, versions, latestBytes, versionOneBytes] = await Promise
    .all([
      repository.findAllForModel(
        context.modelType,
        context.modelId,
      ),
      repository.listVersions(
        context.modelType,
        context.modelId,
        event.instanceName,
      ),
      repository.getContent(
        context.modelType,
        context.modelId,
        event.instanceName,
      ),
      repository.getContent(
        context.modelType,
        context.modelId,
        event.instanceName,
        1,
      ),
    ]);
  const placements = discovered.filter((entry) =>
    entry.name === event.instanceName
  );
  const occupied = placements.length > 0 || versions.length > 0 ||
    latestBytes !== null || versionOneBytes !== null;
  if (!occupied) {
    return await context.writeResource(
      "authority_challenge",
      event.instanceName,
      event,
    );
  }
  if (
    placements.length !== 1 || placements[0].version !== 1 ||
    versions.length !== 1 || versions[0] !== 1 ||
    latestBytes === null || versionOneBytes === null ||
    canonicalJson(JSON.parse(new TextDecoder().decode(latestBytes))) !==
      canonicalJson(JSON.parse(new TextDecoder().decode(versionOneBytes)))
  ) {
    throw new Error(
      `Authority challenge occupied state is not exact version 1 at '${event.instanceName}'`,
    );
  }
  let prior: z.infer<typeof AuthorityChallengeEventSchema>;
  try {
    prior = await validateAuthorityChallengeEvent(
      JSON.parse(new TextDecoder().decode(versionOneBytes)),
      expected,
    );
  } catch (error) {
    throw new Error(
      `Authority challenge occupied state is invalid at '${event.instanceName}': ${
        String(error)
      }`,
    );
  }
  if (canonicalJson(prior) !== canonicalJson(event)) {
    throw new Error(
      `Authority challenge event collision at '${event.instanceName}'`,
    );
  }
  return { name: event.instanceName, version: 1 };
}

function gateContextFrom(
  context: Ctx,
  args: FactoryArguments,
  state: RunState,
  view: RunView,
  workItem: string,
  slug: string,
): GateContext {
  return {
    args,
    state,
    view,
    workItem,
    workItemSlug: slug,
    now: new Date(),
    selfName: context.definition?.name,
    definition: definitionIdentity(context),
    createCelEnvironment: context.createCelEnvironment,
    queryData: queryDataFrom(context),
    dataRepository: context.dataRepository,
  };
}

function formatGateFailures(
  results: { gate: { type: string }; pass: boolean; reasons: string[] }[],
): string {
  const failing = results.filter((r) => !r.pass);
  return failing
    .map((r) => `[${r.gate.type}] ${r.reasons.join("; ")}`)
    .join("\n  ");
}

async function writeJournal(
  context: Ctx,
  workItem: string,
  slug: string,
  entry: {
    event: string;
    stageId?: string;
    summary: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ name: string }> {
  return await context.writeResource("journal", journalInstance(slug), {
    ...entry,
    workItem,
    at: new Date().toISOString(),
  });
}

/**
 * Make definition edits visible without preventing active runs from using the
 * new definition. Legacy states adopt their first observed hash silently.
 */
async function noteDefinitionDrift(
  context: Ctx,
  args: FactoryArguments,
  state: RunState,
  workItem: string,
  slug: string,
): Promise<{ name: string }[]> {
  const newHash = await definitionHash(args);
  if (state.definitionHash === newHash) return [];

  const oldHash = state.definitionHash;
  state.definitionHash = newHash;
  const handles = [
    await context.writeResource(
      "state",
      stateInstance(slug),
      state as unknown as Record<string, unknown>,
    ),
  ];
  if (oldHash !== undefined) {
    handles.push(
      await writeJournal(context, workItem, slug, {
        event: "definition-changed",
        stageId: state.stageId,
        summary: `Factory definition changed while '${workItem}' was active`,
        payload: {
          oldHash,
          newHash,
          stageId: state.stageId,
          cycle: state.cycles[state.stageId],
          definitionVersion: context.definition?.version,
        },
      }),
    );
  }
  return handles;
}

/**
 * Persist a payload-validation failure so a retry can bind it back as feedback
 * (`data.latest(self.name, "validation-<target>")`). Written just before the
 * record method re-throws; the platform keeps writes that precede a throw
 * (method_execution_service collects persisted handles on the error path), so
 * the bad payload is still rejected while its diagnosis survives.
 */
async function recordValidationFailure(
  context: Ctx,
  slug: string,
  envelope: ValidationEnvelope,
): Promise<void> {
  await context.writeResource(
    "validation",
    validationInstance(slug, envelope.target),
    envelope as unknown as Record<string, unknown>,
  );
}

/**
 * Clear an open validation record once its target records cleanly, so a later
 * read (or a fresh stage entry) never binds a stale failure. No-op when none
 * is open.
 */
async function clearValidationIfOpen(
  context: Ctx,
  view: RunView,
  slug: string,
  target: string,
  state: RunState,
): Promise<{ name: string; version?: number } | undefined> {
  const open = liveValidation(view, target);
  if (open === undefined) return undefined;
  const cleared: ValidationEnvelope = {
    target: open.latest.target,
    targetKind: open.latest.targetKind,
    workItem: open.latest.workItem,
    stageId: state.stageId,
    cycle: currentCycle(state),
    attempt: dispatchAttempts(state, state.stageId, currentCycle(state)),
    cleared: true,
    errors: [],
    recordedAt: new Date().toISOString(),
  };
  return await context.writeResource(
    "validation",
    validationInstance(slug, target),
    cleared as unknown as Record<string, unknown>,
  );
}

function normalizePayload(payload: unknown): Record<string, unknown> {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(
        "payload must be a JSON object (or a string containing one)",
      );
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Evidence names a stage declares (explicit + implicit resultEvidence). */
function stageEvidenceNames(stage: StageSpec): string[] {
  const names = (stage.evidence ?? []).map((e) => e.name);
  if (stage.work?.resultEvidence !== undefined) {
    names.push(stage.work.resultEvidence);
  }
  return names;
}

/**
 * What's keeping a stage's current entry from advancing: declared products
 * not yet recorded this cycle, plus the gate reasons still failing. Powers the
 * loud feedback on repeat dispatch and the runaway-loop diagnostics.
 */
async function stageExecutionDiagnostics(
  context: Ctx,
  args: FactoryArguments,
  state: RunState,
  view: RunView,
  workItem: string,
  slug: string,
  stage: StageSpec,
): Promise<{ missing: string[]; gateReasons: string[] }> {
  const cycle = currentCycle(state);
  const recordedThisCycle = (
    rec: { latest: { stageId: string; cycle: number } } | undefined,
  ) =>
    rec !== undefined && rec.latest.stageId === stage.id &&
    rec.latest.cycle === cycle;

  const missing: string[] = [];
  for (const spec of stage.artifacts ?? []) {
    if (!recordedThisCycle(view.artifacts.get(spec.name))) {
      missing.push(`artifact '${spec.name}'`);
    }
  }
  for (const name of stageEvidenceNames(stage)) {
    if (!recordedThisCycle(view.evidence.get(name))) {
      missing.push(`evidence '${name}'`);
    }
  }

  const gateCtx = gateContextFrom(context, args, state, view, workItem, slug);
  const gateReasons: string[] = [];
  for (const t of transitionsFrom(args, stage)) {
    if (isGlobalTransition(args, t.name)) continue;
    const evaluated = await evaluateTransitionGates(t, gateCtx);
    for (const r of evaluated.results) {
      if (!r.pass) {
        gateReasons.push(`[${t.name}/${r.gate.type}] ${r.reasons.join("; ")}`);
      }
    }
  }
  return { missing, gateReasons };
}

/** Loud, actionable feedback for a repeat dispatch (warning) or a tripped cap
 * (fatal). `fatal` is the runaway-loop-suspected hard stop. */
function formatDispatchFeedback(
  stage: StageSpec,
  cycle: number,
  attempt: number,
  limit: number,
  diag: { missing: string[]; gateReasons: string[] },
  fatal: boolean,
): string {
  const lines: string[] = [];
  lines.push(
    fatal
      ? `runaway-loop-suspected: stage '${stage.id}' dispatched ${attempt} time(s) this entry ` +
        `(cycle ${cycle}, limit ${limit}) — refusing to dispatch again. If a human judges ` +
        `another dispatch is warranted (e.g. an attempt was recorded but never executed), ` +
        `they may grant exactly one more with: approve gateId=${DISPATCH_OVERRIDE_PREFIX}${stage.id}`
      : `repeat-dispatch warning: stage '${stage.id}' dispatched ${attempt}/${limit} time(s) ` +
        `this entry (cycle ${cycle}). One dispatch left before the loop guard hard-fails.`,
  );
  lines.push(
    diag.missing.length > 0
      ? `Products not yet recorded for this entry: ${diag.missing.join(", ")}.`
      : `All declared products are recorded for this entry.`,
  );
  if (diag.gateReasons.length > 0) {
    lines.push("Gate(s) still failing:\n  " + diag.gateReasons.join("\n  "));
  }
  lines.push(
    diag.missing.length > 0
      ? `Do NOT re-dispatch. The stage ran but did not record ${
        diag.missing.join(", ")
      } — verify the work actually wrote it (swamp data query …); if it didn't, ` +
        `the work spec or the recording step is the defect, not the gate.`
      : `Do NOT re-dispatch. The products exist but a gate is failing for another ` +
        `reason — address the gate reasons above, not the dispatch.`,
  );
  lines.push("Attempt history is in the journal ('dispatched' events).");
  return lines.join("\n");
}

const WorkItemArg = z.string().min(1).describe(
  "Work item this call is scoped to (issue id, ticket URL, anything)",
);

/**
 * Disambiguates which gate a decision binds to when one approval id gates
 * several transitions from the current stage with different subjects. Needed
 * only in that case; `approve`/`reject` say so explicitly when it applies.
 */
const TransitionArg = z.string().min(1).optional().describe(
  "Transition whose gate this decision is for — only needed when one approval id gates several transitions with different subjects",
);

// ---------------------------------------------------------------------------
// Status rendering
// ---------------------------------------------------------------------------

interface ContextManifestEntry {
  name: string;
  type: "artifact" | "evidence";
  role: "subject" | "own" | "lineage" | "evidence";
  declaredIn: string;
  recorded: boolean;
  version?: number;
  stageId?: string;
  cycle?: number;
}

async function buildStatus(
  context: Ctx,
  args: FactoryArguments,
  state: RunState,
  view: RunView,
  workItem: string,
  slug: string,
): Promise<Record<string, unknown>> {
  const stage = requireCurrentStage(args, state);
  const cycle = currentCycle(state);

  // Per-transition gate evaluation.
  const gateCtx = gateContextFrom(context, args, state, view, workItem, slug);
  const transitions: Record<string, unknown>[] = [];
  for (const t of transitionsFrom(args, stage)) {
    const evaluated = await evaluateTransitionGates(t, gateCtx);
    const limit = cycleLimitFor(args, view, state, t.to);
    transitions.push({
      name: t.name,
      to: t.to,
      manual: t.manual === true,
      satisfied: evaluated.pass && limit.allowed,
      cycleLimitBlocked: !limit.allowed,
      gates: evaluated.results.map((r) => ({
        type: r.gate.type,
        pass: r.pass,
        reasons: r.reasons,
      })),
    });
  }

  // Subject binding for every human-approval gate reachable from here: what a
  // human would be approving right now, and what the run has already decided
  // about it. This is what makes an approval reviewable before it is given —
  // the human (or the driver relaying to them) sees the exact digest and the
  // records behind it, not just "approval required".
  const approvalGates = await buildApprovalSubjects(
    context,
    args,
    state,
    view,
    workItem,
  );

  // Context manifest: everything recorded or declared, with roles.
  const subjects = new Set(
    (stage.artifacts ?? [])
      .map((a) => a.reviews)
      .filter((s): s is string => s !== undefined),
  );
  const ownNames = new Set((stage.artifacts ?? []).map((a) => a.name));
  const manifest: ContextManifestEntry[] = [];
  for (const s of args.stages) {
    for (const spec of s.artifacts ?? []) {
      const recorded = view.artifacts.get(spec.name);
      manifest.push({
        name: spec.name,
        type: "artifact",
        role: subjects.has(spec.name)
          ? "subject"
          : ownNames.has(spec.name)
          ? "own"
          : "lineage",
        declaredIn: s.id,
        recorded: recorded !== undefined,
        version: recorded?.version,
        stageId: recorded?.latest.stageId,
        cycle: recorded?.latest.cycle,
      });
    }
    for (const name of stageEvidenceNames(s)) {
      const recorded = view.evidence.get(name);
      manifest.push({
        name,
        type: "evidence",
        role: "evidence",
        declaredIn: s.id,
        recorded: recorded !== undefined,
        version: recorded?.version,
        stageId: recorded?.latest.stageId,
        cycle: recorded?.latest.cycle,
      });
    }
  }

  // Resolve run-data bindings in the work spec, when an evaluator exists.
  let work: WorkSpec | undefined = stage.work;
  let unresolvedBindings: { expression: string; error: string }[] = [];
  if (stage.work !== undefined && context.createCelEnvironment !== undefined) {
    const env = context.createCelEnvironment();
    const celContext = prepareBindingEnvironment(
      env,
      context.definition?.name ?? "",
      {
        workItem,
        // Immutable engine context for this resolution only. `state` is the
        // authoritative persisted run position; do not merge authored values.
        stage: state.stageId,
        cycle,
      },
      view,
    );
    const resolved = resolveBindings(
      stage.work,
      (expression) => env.evaluate(expression, celContext),
    );
    work = resolved.value;
    unresolvedBindings = resolved.unresolved;
  }

  // Validate the resolved method/workflow inputs against the stage's declared
  // inputsSchema. This catches an upstream value that drifted shape (a list
  // recorded as a string, a number as text) at the boundary the factory owns,
  // before the driver dispatches it into a strict downstream method. Skipped
  // while bindings are still unresolved — the inputs aren't complete yet.
  const invalidInputs: { path: string; message: string }[] = [];
  if (
    stage.work?.inputsSchema !== undefined &&
    work !== undefined &&
    unresolvedBindings.length === 0
  ) {
    const resolvedInputs = work.method?.inputs ?? work.workflow?.inputs;
    if (resolvedInputs !== undefined) {
      const issues = validateDeclaredPayload(
        stage.work.inputsSchema,
        resolvedInputs,
      );
      for (const issue of issues ?? []) {
        const sep = issue.indexOf(": ");
        invalidInputs.push(
          sep >= 0
            ? { path: issue.slice(0, sep), message: issue.slice(sep + 2) }
            : { path: "(root)", message: issue },
        );
      }
    }
  }

  const cycles: Record<string, { entries: number; limit: number }> = {};
  for (const s of args.stages) {
    cycles[s.id] = {
      entries: entriesInto(state, s.id),
      limit: maxCyclesFor(s),
    };
  }

  const pendingApprovals = transitions.flatMap((t) =>
    (t.gates as { type: string; pass: boolean }[])
      .filter((g) => g.type === "human-approval" && !g.pass)
      .map(() => t.name as string)
  );

  return {
    started: true,
    workItem,
    definitionVersion: state.definitionVersion,
    stage: {
      id: stage.id,
      description: stage.description,
      terminal: stage.terminal === true,
      cycle,
      maxCycles: maxCyclesFor(stage),
    },
    status: state.status,
    dispatch: {
      cycle,
      attempts: dispatchAttempts(state, stage.id, cycle),
      // Includes human-granted dispatch-override:<stage> grants for this
      // entry, so the packet shows the budget record_dispatch will enforce.
      limit: maxDispatchesFor(stage) +
        approvedDispatchOverrides(view, stage.id, cycle),
      // A work-bearing stage must be dispatched (record_dispatch) before it
      // can advance, so its execution is provable and can't be skipped.
      required: stage.work !== undefined,
      executed: dispatchAttempts(state, stage.id, cycle) >= 1,
    },
    // Open (uncleared) payload-validation failures, bindable as retry feedback
    // via data.latest(self.name, "validation-<target>").
    validations: [...view.validations.values()]
      .filter((v) => !v.latest.cleared)
      .map((v) => ({
        target: v.latest.target,
        targetKind: v.latest.targetKind,
        stageId: v.latest.stageId,
        cycle: v.latest.cycle,
        attempt: v.latest.attempt,
        errors: v.latest.errors,
      })),
    work,
    unresolvedBindings,
    invalidInputs,
    transitions,
    contextManifest: manifest,
    cycles,
    pendingApprovals,
    // Per-approval-gate subject binding: for bound gates, the digest and
    // manifest a decision taken right now would carry; for unbound gates, an
    // explicit `bound: false` so a reader never has to infer it from absence.
    approvalGates,
  };
}

interface ApprovalGateStatus {
  gateId: string;
  transitions: string[];
  bound: boolean;
  satisfied: boolean;
  minApprovals: number;
  /** Approvals in force for the current subject (bound) or slot (unbound). */
  approvals: number;
  /** Latest rejection still in force for the current exact subject. */
  rejection?: { actor: string; note?: string };
  subject?: {
    algorithm: string;
    manifestVersion: string;
    digest: string;
    selects: { artifacts: string[]; evidence: string[] };
    manifest: Record<string, unknown>;
    /** Selected records not yet recorded — the subject is incomplete. */
    missing: { kind: string; name: string }[];
  };
  /** Decisions on this gate this cycle that do not bind the current subject. */
  staleDecisions: {
    actor: string;
    decision: string;
    subjectStatus: string;
    digest?: string;
  }[];
  /** Actionable, deterministic comparison with the latest exact-scope approval. */
  presentations?: ApprovalPresentation[];
}

interface PresentedRecord {
  kind: "artifact" | "evidence";
  name: string;
  previous?: Record<string, unknown>;
  current?: Record<string, unknown>;
  status:
    | "identical"
    | "recording-changed-payload-identical"
    | "changed"
    | "added"
    | "removed"
    | "unavailable";
  operations: JsonPointerOperation[];
}

interface JsonPointerOperation {
  op: "add" | "remove" | "replace";
  path: string;
  previous?: unknown;
  current?: unknown;
}

interface ApprovalPresentation {
  transition: string;
  current: {
    digest: string;
    algorithm: string;
    manifestVersion: string;
    manifest: Record<string, unknown>;
    subjectContractVersion: string;
    subjectContractDigest: string;
  };
  previous: {
    status: "none" | "available" | "unavailable" | "malformed";
    approvalResourceVersion?: number;
    digest?: string;
    manifest?: Record<string, unknown>;
    reason?: string;
  };
  comparison: {
    status:
      | "first-approval"
      | "identical"
      | "recording-changed-payload-identical"
      | "changed"
      | "unavailable"
      | "malformed";
    records: PresentedRecord[];
  };
}

/**
 * Subject state for every human-approval gate reachable from the current
 * stage. Gates sharing an id across transitions with the same subject are one
 * entry (they are the same decision); differing subjects are reported per
 * transition so the ambiguity is visible in `status` rather than only at
 * `approve` time.
 */
async function buildApprovalSubjects(
  context: Ctx,
  args: FactoryArguments,
  state: RunState,
  view: RunView,
  workItem: string,
): Promise<ApprovalGateStatus[]> {
  const stage = findStage(args, state.stageId);
  if (stage === undefined) return [];
  const cycle = currentCycle(state);

  const ids: string[] = [];
  for (const t of transitionsFrom(args, stage)) {
    for (const gate of t.gates ?? []) {
      if (gate.type === "human-approval" && !ids.includes(gate.config.id)) {
        ids.push(gate.config.id);
      }
    }
  }

  const out: ApprovalGateStatus[] = [];
  for (const gateId of ids) {
    const inScope = approvalGatesInScope(args, state.stageId, gateId);
    const { spec, ambiguous } = resolveSubjectSpec(inScope);
    const transitionNames = inScope.map((g) => g.transition.name);
    const minApprovals = Math.max(
      ...inScope.map((g) => g.gate.config.minApprovals ?? 1),
    );
    const decisions = (view.approvals.get(gateId) ?? []).filter(
      (r) => r.stageId === state.stageId && r.cycle === cycle,
    );

    // An ambiguous id has no single subject to show; the graph check reports
    // it as a definition error, so surface the shape without a digest.
    if (spec === undefined || ambiguous.length > 0) {
      const approvals = decisions.filter(
        (r) => r.decision === "approved",
      ).length;
      out.push({
        gateId,
        transitions: transitionNames,
        bound: false,
        satisfied: approvals >= minApprovals &&
          decisions[decisions.length - 1]?.decision !== "rejected",
        minApprovals,
        approvals,
        staleDecisions: [],
      });
      continue;
    }

    const current = await computeApprovalSubject({
      gateId,
      subject: spec,
      workItem,
      state,
      view,
      definition: definitionIdentity(context),
    });
    const matching = decisions.filter(
      (r) =>
        r.subjectStatus === "bound" && r.subject?.digest === current.digest,
    );
    const approvals = matching.filter((r) => r.decision === "approved").length;
    const rejection = latestMatchingRejection(matching, current.digest);
    out.push({
      gateId,
      transitions: transitionNames,
      bound: true,
      satisfied: current.missing.length === 0 &&
        approvals >= minApprovals &&
        rejection === undefined,
      minApprovals,
      approvals,
      rejection: rejection === undefined
        ? undefined
        : { actor: rejection.actor, note: rejection.note },
      subject: {
        algorithm: current.algorithm,
        manifestVersion: current.manifest.manifestVersion,
        digest: current.digest,
        selects: {
          artifacts: spec.artifacts ?? [],
          evidence: spec.evidence ?? [],
        },
        manifest: current.manifest as unknown as Record<string, unknown>,
        missing: current.missing,
      },
      staleDecisions: decisions
        .filter(
          (r) =>
            r.subjectStatus !== "bound" ||
            r.subject?.digest !== current.digest,
        )
        .map((r) => ({
          actor: r.actor,
          decision: r.decision,
          subjectStatus: r.subjectStatus ?? "unbound",
          digest: r.subject?.digest,
        })),
      presentations: await Promise.all(
        transitionNames.map(async (transition) => {
          const contract = await computeApprovalSubjectContract({
            gateId,
            transition,
            subject: spec,
          });
          return await buildApprovalPresentation(
            context,
            view,
            workItem,
            state,
            gateId,
            transition,
            spec,
            current,
            contract,
          );
        }),
      ),
    });
  }
  return out;
}

async function buildApprovalPresentation(
  context: Ctx,
  view: RunView,
  workItem: string,
  state: RunState,
  gateId: string,
  transition: string,
  spec: ApprovalSubjectSpec,
  current: ApprovalSubject,
  contract: { version: string; digest: string },
): Promise<ApprovalPresentation> {
  const base: ApprovalPresentation["current"] = {
    digest: current.digest,
    algorithm: current.algorithm,
    manifestVersion: current.manifest.manifestVersion,
    manifest: current.manifest as unknown as Record<string, unknown>,
    subjectContractVersion: contract.version,
    subjectContractDigest: contract.digest,
  };
  const historyIssues = view.approvalHistoryIssues.get(gateId) ?? [];
  const historyFailure = historyIssues[0];
  if (historyFailure !== undefined) {
    return {
      transition,
      current: base,
      previous: { status: "unavailable", reason: historyFailure.reason },
      comparison: { status: "unavailable", records: [] },
    };
  }
  const candidates = (view.approvalHistory.get(gateId) ?? []).filter((record) =>
    record.decision === "approved" && record.workItem === workItem &&
    record.comparisonIdentity?.transition === transition &&
    record.comparisonIdentity.runEra === state.startedAt &&
    record.comparisonIdentity.subjectContractVersion === contract.version &&
    record.comparisonIdentity.subjectContractDigest === contract.digest
  ).sort((a, b) => b.resourceVersion - a.resourceVersion);
  const selected = candidates[0];
  if (selected === undefined) {
    const legacy = (view.approvalHistory.get(gateId) ?? []).some((record) =>
      record.decision === "approved" && record.comparisonIdentity === undefined
    );
    const historyUnavailable = historyIssues.some((issue) =>
      issue.kind === "unavailable" || issue.kind === "gc-gap"
    );
    const unavailable = legacy || historyUnavailable;
    return {
      transition,
      current: base,
      previous: unavailable
        ? {
          status: "unavailable",
          reason: historyIssues[0]?.reason ??
            "previous approval lacks exact comparison identity",
        }
        : { status: "none" },
      comparison: {
        status: unavailable ? "unavailable" : "first-approval",
        records: [],
      },
    };
  }

  const malformed = await validatePreviousSubject(
    selected,
    workItem,
    gateId,
    spec,
    current,
  );
  if (malformed !== undefined) {
    return {
      transition,
      current: base,
      previous: {
        status: "malformed",
        approvalResourceVersion: selected.resourceVersion,
        reason: malformed,
      },
      comparison: { status: "malformed", records: [] },
    };
  }
  const previousSubject = selected.subject!;
  const previousManifest = previousSubject.manifest;
  const previousRecords = previousManifest.records as Record<string, unknown>[];
  const previousPayloads = new Map<string, unknown>();
  for (const previousRecord of previousRecords) {
    const loaded = await exactPayload(context, workItem, previousRecord);
    if (loaded.status !== "available") {
      return {
        transition,
        current: base,
        previous: {
          status: loaded.status,
          approvalResourceVersion: selected.resourceVersion,
          reason: loaded.reason,
        },
        comparison: { status: loaded.status, records: [] },
      };
    }
    previousPayloads.set(
      `${previousRecord.kind}:${previousRecord.name}`,
      loaded.payload,
    );
  }
  const records: PresentedRecord[] = [];
  const previousByKey = new Map(
    previousRecords.map((r) => [`${r.kind}:${r.name}`, r]),
  );
  for (const currentRecord of current.manifest.records) {
    const key = `${currentRecord.kind}:${currentRecord.name}`;
    const previousRecord = previousByKey.get(key);
    if (previousRecord === undefined) {
      records.push({
        kind: currentRecord.kind,
        name: currentRecord.name,
        current: currentRecord as unknown as Record<string, unknown>,
        status: "added",
        operations: [],
      });
      continue;
    }
    previousByKey.delete(key);
    const currentView = currentRecord.kind === "artifact"
      ? view.artifacts.get(currentRecord.name)?.latest
      : view.evidence.get(currentRecord.name)?.latest;
    const operations = jsonPointerDiff(
      previousPayloads.get(key),
      currentView?.payload,
    );
    const samePayload =
      previousRecord.payloadDigest === currentRecord.payloadDigest;
    const sameRecording =
      canonicalJson(previousRecord) === canonicalJson(currentRecord);
    records.push({
      kind: currentRecord.kind,
      name: currentRecord.name,
      previous: previousRecord,
      current: currentRecord as unknown as Record<string, unknown>,
      status: sameRecording
        ? "identical"
        : samePayload
        ? "recording-changed-payload-identical"
        : "changed",
      operations,
    });
  }
  for (const previousRecord of previousRecords) {
    const key = `${previousRecord.kind}:${previousRecord.name}`;
    if (!previousByKey.has(key)) continue;
    records.push({
      kind: previousRecord.kind as "artifact" | "evidence",
      name: previousRecord.name as string,
      previous: previousRecord,
      status: "removed",
      operations: [],
    });
  }
  const statuses = records.map((r) => r.status);
  const comparisonStatus = previousSubject.digest === current.digest
    ? "identical"
    : statuses.every((s) =>
        s === "identical" || s === "recording-changed-payload-identical"
      )
    ? "recording-changed-payload-identical"
    : "changed";
  return {
    transition,
    current: base,
    previous: {
      status: "available",
      approvalResourceVersion: selected.resourceVersion,
      digest: previousSubject.digest,
      manifest: previousManifest,
    },
    comparison: { status: comparisonStatus, records },
  };
}

async function validatePreviousSubject(
  record: ApprovalRecord,
  workItem: string,
  gateId: string,
  spec: ApprovalSubjectSpec,
  current: ApprovalSubject,
): Promise<string | undefined> {
  const subject = record.subject;
  if (record.subjectStatus !== "bound" || subject === undefined) {
    return "exact-scope approval has no bound subject";
  }
  if (!/^[0-9a-f]{64}$/.test(subject.digest)) return "invalid subject digest";
  if (subject.algorithm !== current.algorithm) {
    return "unsupported subject algorithm";
  }
  if (subject.manifestVersion !== subject.manifest.manifestVersion) {
    return "subject manifest version binding is inconsistent";
  }
  try {
    const manifest = parseApprovalSubjectManifest(subject.manifest);
    if (manifest.workItem !== workItem || manifest.gate.id !== gateId) {
      return "subject manifest gate/work-item identity is inconsistent";
    }
    if (
      manifest.run !== undefined &&
      (record.stageId !== manifest.run.stageId ||
        record.cycle !== manifest.run.cycle ||
        record.comparisonIdentity?.runEra !== manifest.run.era ||
        manifest.run.era !== current.manifest.run?.era)
    ) {
      return "approval envelope and subject manifest run identity are inconsistent";
    }
    if (
      canonicalJson(manifest.run ?? null) !==
        canonicalJson(current.manifest.run ?? null)
    ) {
      return "subject manifest run identity is inconsistent";
    }
    if (
      canonicalJson(manifest.definition ?? null) !==
        canonicalJson(current.manifest.definition ?? null)
    ) return "subject manifest definition identity is inconsistent";
    const expected = [
      ...(spec.artifacts ?? []).map((name) => `artifact:${name}`),
      ...(spec.evidence ?? []).map((name) => `evidence:${name}`),
    ];
    const actual = manifest.records.map((entry) =>
      `${entry.kind}:${entry.name}`
    );
    if (
      new Set(actual).size !== actual.length ||
      canonicalJson(actual) !== canonicalJson(expected)
    ) {
      return "subject manifest record selection/order is inconsistent";
    }
    const canonical = canonicalJson(manifest);
    if (await sha256Hex(canonical) !== subject.digest) {
      return "subject digest does not match manifest";
    }
  } catch {
    return "subject manifest is not canonical JSON";
  }
  return undefined;
}

async function exactPayload(
  context: Ctx,
  workItem: string,
  identity: Record<string, unknown>,
): Promise<
  | { status: "available"; payload: unknown }
  | { status: "unavailable" | "malformed"; reason: string }
> {
  const kind = identity.kind;
  const name = identity.name;
  const version = identity.version;
  if (
    (kind !== "artifact" && kind !== "evidence") || typeof name !== "string" ||
    typeof version !== "number"
  ) {
    return {
      status: "malformed",
      reason: "historical manifest record identity is malformed",
    };
  }
  const instance = kind === "artifact"
    ? artifactInstance(workItemSlug(workItem), name)
    : evidenceInstance(workItemSlug(workItem), name);
  let bytes: Uint8Array | null;
  try {
    bytes = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      instance,
      version,
    );
  } catch {
    return {
      status: "unavailable",
      reason:
        `exact historical ${kind} '${name}' resource version ${version} could not be read`,
    };
  }
  if (bytes === null) {
    return {
      status: "unavailable",
      reason:
        `exact historical ${kind} '${name}' resource version ${version} is unavailable`,
    };
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    const envelope = kind === "artifact"
      ? ArtifactEnvelopeSchema.strict().parse(decoded)
      : EvidenceEnvelopeSchema.strict().parse(decoded);
    if (
      envelope.name !== name || envelope.workItem !== workItem ||
      envelope.stageId !== identity.stageId ||
      envelope.cycle !== identity.cycle ||
      envelope.recordedAt !== identity.recordedAt ||
      await sha256Hex(canonicalJson(envelope.payload)) !==
        identity.payloadDigest
    ) {
      return {
        status: "malformed",
        reason:
          `exact historical ${kind} '${name}' envelope identity or payload digest is inconsistent`,
      };
    }
    return { status: "available", payload: envelope.payload };
  } catch {
    return {
      status: "malformed",
      reason: `exact historical ${kind} '${name}' envelope is malformed`,
    };
  }
}

function jsonPointerDiff(
  previous: unknown,
  current: unknown,
): JsonPointerOperation[] {
  const out: JsonPointerOperation[] = [];
  diffAt(previous, current, "", out);
  return out;
}

function diffAt(
  previous: unknown,
  current: unknown,
  path: string,
  out: JsonPointerOperation[],
): void {
  if (canonicalJson(previous) === canonicalJson(current)) return;
  if (isPlainObject(previous) && isPlainObject(current)) {
    const previousKeys = Object.keys(previous).sort();
    const currentKeys = Object.keys(current).sort();
    for (const key of currentKeys) {
      const child = `${path}/${escapePointer(key)}`;
      if (!(key in previous)) {
        out.push({ op: "add", path: child, current: current[key] });
      } else diffAt(previous[key], current[key], child, out);
    }
    for (const key of previousKeys) {
      if (!(key in current)) {
        out.push({
          op: "remove",
          path: `${path}/${escapePointer(key)}`,
          previous: previous[key],
        });
      }
    }
    return;
  }
  if (Array.isArray(previous) && Array.isArray(current)) {
    const common = Math.min(previous.length, current.length);
    for (let i = 0; i < common; i++) {
      diffAt(previous[i], current[i], `${path}/${i}`, out);
    }
    for (let i = common; i < current.length; i++) {
      out.push({ op: "add", path: `${path}/${i}`, current: current[i] });
    }
    for (let i = previous.length - 1; i >= current.length; i--) {
      out.push({ op: "remove", path: `${path}/${i}`, previous: previous[i] });
    }
    return;
  }
  out.push({ op: "replace", path, previous, current });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

// ---------------------------------------------------------------------------
// Model definition
// ---------------------------------------------------------------------------

const MUTATING_METHODS = [
  "record_dispatch",
  "record_artifact",
  "record_evidence",
  "resolve_findings",
  "mint_authority_challenge",
  "approve",
  "reject",
  "advance",
];

/** Extract the workItem a check should scope to; null when unavailable. */
function checkWorkItem(context: CheckCtx): string | null {
  const workItem = context.unresolvedMethodArgs?.workItem;
  return typeof workItem === "string" && workItem.length > 0 ? workItem : null;
}

async function checkState(
  context: CheckCtx,
  workItem: string,
): Promise<RunState | null> {
  const view = await viewFor(context, workItemSlug(workItem), workItem);
  return view.state;
}

/**
 * Generic software-factory model definition.
 *
 * Factory stages, transitions, gates, work specifications, and artifact
 * schemas are supplied as global arguments; methods persist and advance each
 * work item's isolated run state.
 */
export const model = {
  type: "@mgreten/software-factory",
  version: "2026.08.18.2",
  upgrades: [
    {
      toVersion: "2026.08.12.2",
      description: "Align the model version with the package release",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.18.1",
      description: "Add generic workflow attempt lease lifecycle primitives",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.08.18.2",
      description:
        "Read runs created under the former @swamp package namespace",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: PlatformArgumentsSchema,
  reports: ["@mgreten/software-factory/work-item-summary"],

  resources: {
    "state": {
      description:
        "Per-work-item stage, cycle counts, and run status (instances: state-<workItem>)",
      // Typed envelope: the resource layer validates structure on every write
      // (payloads are validated separately against their declared schema).
      schema: RunStateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 25,
    },
    "artifact": {
      description:
        "Versioned, schema-validated data products (instances: artifact-<workItem>-<name>)",
      schema: ArtifactEnvelopeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "evidence": {
      description:
        "Schema-validated external facts recorded by the driver (instances: evidence-<workItem>-<name>)",
      schema: EvidenceEnvelopeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "approval": {
      description:
        "Human gate decisions, cycle-scoped (instances: approval-<workItem>-<gateId>)",
      schema: ApprovalRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "authority_challenge": {
      description:
        "Engine-minted immutable non-authorizing challenge events (instances: authority-challenge-<event-digest>)",
      schema: AuthorityChallengeEventSchema,
      lifetime: "infinite" as const,
      // Every event has its own content-addressed instance. A second version is
      // only an identical retry, never additional history.
      garbageCollection: 1,
    },
    "validation": {
      description:
        "Recorded payload-validation failures, bindable as retry feedback (instances: validation-<workItem>-<target>)",
      schema: ValidationEnvelopeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "journal": {
      description:
        "Append-only audit trail per work item (instances: journal-<workItem>)",
      schema: JournalEntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 200,
    },
    "status": {
      description:
        "Materialized 'what is required next' view, refreshed on every status " +
        "call and queryable with `swamp data query` (instances: " +
        "status-<workItem>, status-_factory for the fleet overview)",
      // Permissive envelope: the view is large and partly dynamic; the driver
      // projects exact fields via --select rather than reading the whole blob.
      schema: StatusEnvelopeSchema,
      lifetime: "infinite" as const,
      // A read-time cache, not history — keep only the last few refreshes.
      garbageCollection: 3,
    },
    "attempt_lease": {
      description: "Provider-neutral workflow attempt lease and outcome",
      schema: AttemptLeaseSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },

  checks: {
    "run-started": {
      description:
        "Every mutating method requires a started run for its work item",
      labels: ["policy"],
      appliesTo: MUTATING_METHODS,
      execute: async (context: CheckCtx): Promise<CheckResult> => {
        const workItem = checkWorkItem(context);
        if (workItem === null) return { pass: true }; // method validates
        const state = await checkState(context, workItem);
        if (state === null) {
          return {
            pass: false,
            errors: [
              `No run for work item '${workItem}'. Run 'start' with workItem=${workItem} first.`,
            ],
          };
        }
        return { pass: true };
      },
    },

    "not-terminal": {
      description: "Terminal runs reject all mutating methods",
      labels: ["policy"],
      appliesTo: MUTATING_METHODS,
      execute: async (context: CheckCtx): Promise<CheckResult> => {
        const workItem = checkWorkItem(context);
        if (workItem === null) return { pass: true };
        const state = await checkState(context, workItem);
        if (state === null) return { pass: true }; // run-started reports it
        if (state.status === "terminal") {
          return {
            pass: false,
            errors: [
              `Run for work item '${workItem}' is terminal (stage '${state.stageId}'). Use 'reset' to start it over.`,
            ],
          };
        }
        return { pass: true };
      },
    },

    "graph-valid": {
      description:
        "The definition parses, the graph is valid, and the run's current stage exists",
      labels: ["policy"],
      appliesTo: ["start", "reset", ...MUTATING_METHODS],
      execute: async (context: CheckCtx): Promise<CheckResult> => {
        let args: FactoryArguments;
        try {
          ({ args } = await loadFactoryArgs(context));
        } catch (error) {
          return {
            pass: false,
            errors: [error instanceof Error ? error.message : String(error)],
          };
        }
        const { errors } = validateGraph(args);
        if (errors.length > 0) {
          return {
            pass: false,
            errors: errors.map((e) => `definition: ${e}`),
          };
        }
        const workItem = checkWorkItem(context);
        if (workItem !== null) {
          const state = await checkState(context, workItem);
          if (state !== null && findStage(args, state.stageId) === undefined) {
            return {
              pass: false,
              errors: [
                `Current stage '${state.stageId}' no longer exists in the definition.`,
              ],
            };
          }
        }
        return { pass: true };
      },
    },

    "valid-transition": {
      description:
        "advance's transition must exist from the current stage (or be global)",
      labels: ["policy"],
      appliesTo: ["advance"],
      execute: async (context: CheckCtx): Promise<CheckResult> => {
        const name = context.unresolvedMethodArgs?.transition;
        const workItem = checkWorkItem(context);
        if (typeof name !== "string" || workItem === null) {
          return { pass: true }; // method validates
        }
        let args: FactoryArguments;
        try {
          ({ args } = await loadFactoryArgs(context));
        } catch {
          return { pass: true }; // graph-valid reports it
        }
        const state = await checkState(context, workItem);
        if (state === null) return { pass: true }; // run-started reports it
        const stage = findStage(args, state.stageId);
        if (stage === undefined) return { pass: true }; // graph-valid reports it
        const available = transitionsFrom(args, stage);
        if (!available.some((t) => t.name === name)) {
          const names = available.map((t) => t.name).join(", ") || "(none)";
          return {
            pass: false,
            errors: [
              `Transition '${name}' is not available from stage '${stage.id}'. Available: ${names}`,
            ],
          };
        }
        return { pass: true };
      },
    },

    "gates-satisfied": {
      description: "All gates on the chosen transition must pass",
      labels: ["policy"],
      appliesTo: ["advance"],
      execute: async (context: CheckCtx): Promise<CheckResult> => {
        const name = context.unresolvedMethodArgs?.transition;
        const workItem = checkWorkItem(context);
        if (typeof name !== "string" || workItem === null) {
          return { pass: true };
        }
        let args: FactoryArguments;
        try {
          ({ args } = await loadFactoryArgs(context));
        } catch {
          return { pass: true };
        }
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        if (view.state === null) return { pass: true };
        const stage = findStage(args, view.state.stageId);
        if (stage === undefined) return { pass: true };
        const transition = transitionsFrom(args, stage).find(
          (t) => t.name === name,
        );
        if (transition === undefined) return { pass: true }; // valid-transition reports it
        const evaluated = await evaluateTransitionGates(
          transition,
          gateContextFrom(context, args, view.state, view, workItem, slug),
        );
        if (!evaluated.pass) {
          return {
            pass: false,
            errors: evaluated.results
              .filter((r) => !r.pass)
              .map((r) => `[${r.gate.type}] ${r.reasons.join("; ")}`),
          };
        }
        return { pass: true };
      },
    },

    "cycle-limits": {
      description:
        "Entering a stage past its maxCycles requires a human cycle-override approval",
      labels: ["policy"],
      appliesTo: ["advance"],
      execute: async (context: CheckCtx): Promise<CheckResult> => {
        const name = context.unresolvedMethodArgs?.transition;
        const workItem = checkWorkItem(context);
        if (typeof name !== "string" || workItem === null) {
          return { pass: true };
        }
        let args: FactoryArguments;
        try {
          ({ args } = await loadFactoryArgs(context));
        } catch {
          return { pass: true };
        }
        const view = await viewFor(context, workItemSlug(workItem), workItem);
        if (view.state === null) return { pass: true };
        const stage = findStage(args, view.state.stageId);
        if (stage === undefined) return { pass: true };
        const transition = transitionsFrom(args, stage).find(
          (t) => t.name === name,
        );
        if (transition === undefined) return { pass: true };
        const limit = cycleLimitFor(args, view, view.state, transition.to);
        if (!limit.allowed) {
          return {
            pass: false,
            errors: [cycleLimitError(transition.to, limit)],
          };
        }
        return { pass: true };
      },
    },

    "stage-executed": {
      description:
        "Advancing out of a work-bearing stage requires a recorded dispatch for the current entry — the stage's work must run through the factory",
      labels: ["policy"],
      appliesTo: ["advance"],
      execute: async (context: CheckCtx): Promise<CheckResult> => {
        const name = context.unresolvedMethodArgs?.transition;
        const workItem = checkWorkItem(context);
        if (typeof name !== "string" || workItem === null) {
          return { pass: true };
        }
        let args: FactoryArguments;
        try {
          ({ args } = await loadFactoryArgs(context));
        } catch {
          return { pass: true };
        }
        // Escape-hatch (global) transitions stay available unconditionally.
        if (isGlobalTransition(args, name)) return { pass: true };
        const state = await checkState(context, workItem);
        if (state === null) return { pass: true };
        const stage = findStage(args, state.stageId);
        if (stage === undefined || stage.work === undefined) {
          return { pass: true };
        }
        if (!(stage.transitions ?? []).some((t) => t.name === name)) {
          return { pass: true }; // valid-transition reports unknown names
        }
        if (dispatchAttempts(state, stage.id, currentCycle(state)) < 1) {
          return {
            pass: false,
            errors: [stageNotExecutedError(stage.id, workItem)],
          };
        }
        return { pass: true };
      },
    },
  },

  methods: {
    begin_attempt: {
      description: "Acquire a provider-neutral lease for a workflow attempt.",
      arguments: z.object({
        workItem: WorkItemArg,
        attemptId: z.string().min(1),
        owner: z.string().min(1),
        leaseSeconds: z.number().int().positive().max(86400).default(900),
      }),
      execute: async (
        a: {
          workItem: string;
          attemptId: string;
          owner: string;
          leaseSeconds: number;
        },
        context: Ctx,
      ) => {
        const view = await viewFor(
          context,
          workItemSlug(a.workItem),
          a.workItem,
        );
        const state = requireState(view, a.workItem);
        requireActive(state);
        const name = `attempt-${workItemSlug(a.workItem)}-${a.attemptId}`;
        const prior = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          name,
        );
        if (prior !== null) return { dataHandles: [{ name }] };
        const now = Date.now();
        const iso = new Date(now).toISOString();
        return {
          dataHandles: [
            await context.writeResource("attempt_lease", name, {
              workItem: a.workItem,
              attemptId: a.attemptId,
              stageId: state.stageId,
              status: "leased",
              owner: a.owner,
              leasedAt: iso,
              heartbeatAt: iso,
              expiresAt: new Date(now + a.leaseSeconds * 1000).toISOString(),
            }),
          ],
        };
      },
    },
    heartbeat_attempt: {
      description: "Renew an active workflow attempt lease.",
      arguments: z.object({
        workItem: WorkItemArg,
        attemptId: z.string().min(1),
        leaseSeconds: z.number().int().positive().max(86400).default(900),
      }),
      execute: async (
        a: { workItem: string; attemptId: string; leaseSeconds: number },
        context: Ctx,
      ) => {
        const name = `attempt-${workItemSlug(a.workItem)}-${a.attemptId}`;
        const raw = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          name,
        );
        if (raw === null) throw new Error(`Unknown attempt '${a.attemptId}'.`);
        const lease = AttemptLeaseSchema.parse(
          JSON.parse(new TextDecoder().decode(raw)),
        );
        if (lease.status !== "leased") return { dataHandles: [{ name }] };
        const now = Date.now();
        return {
          dataHandles: [
            await context.writeResource("attempt_lease", name, {
              ...lease,
              heartbeatAt: new Date(now).toISOString(),
              expiresAt: new Date(now + a.leaseSeconds * 1000).toISOString(),
            }),
          ],
        };
      },
    },
    complete_attempt: {
      description:
        "Complete an attempt with a bounded retry, fail, or stop decision.",
      arguments: z.object({
        workItem: WorkItemArg,
        attemptId: z.string().min(1),
        decision: z.enum(["retry", "fail", "stop"]),
        reason: z.string().min(1),
        result: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (
        a: {
          workItem: string;
          attemptId: string;
          decision: "retry" | "fail" | "stop";
          reason: string;
          result?: Record<string, unknown>;
        },
        context: Ctx,
      ) => {
        const name = `attempt-${workItemSlug(a.workItem)}-${a.attemptId}`;
        const raw = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          name,
        );
        if (raw === null) throw new Error(`Unknown attempt '${a.attemptId}'.`);
        const lease = AttemptLeaseSchema.parse(
          JSON.parse(new TextDecoder().decode(raw)),
        );
        if (lease.status === "completed") return { dataHandles: [{ name }] };
        return {
          dataHandles: [
            await context.writeResource("attempt_lease", name, {
              ...lease,
              status: "completed",
              completedAt: new Date().toISOString(),
              decision: a.decision,
              reason: a.reason,
              result: a.result,
            }),
          ],
        };
      },
    },
    claim_orphan_attempt: {
      description: "Mark an expired attempt lease orphaned, idempotently.",
      arguments: z.object({
        workItem: WorkItemArg,
        attemptId: z.string().min(1),
        owner: z.string().min(1),
      }),
      execute: async (
        a: { workItem: string; attemptId: string; owner: string },
        context: Ctx,
      ) => {
        const name = `attempt-${workItemSlug(a.workItem)}-${a.attemptId}`;
        const raw = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          name,
        );
        if (raw === null) throw new Error(`Unknown attempt '${a.attemptId}'.`);
        const lease = AttemptLeaseSchema.parse(
          JSON.parse(new TextDecoder().decode(raw)),
        );
        if (
          lease.status !== "leased" || Date.parse(lease.expiresAt) > Date.now()
        ) return { dataHandles: [{ name }] };
        return {
          dataHandles: [
            await context.writeResource("attempt_lease", name, {
              ...lease,
              status: "orphaned",
              owner: a.owner,
              reason: "lease-expired",
            }),
          ],
        };
      },
    },
    start: {
      description:
        "Validate the definition and start a run for a work item at the initial stage. Fails if that work item already has a run (resume with 'status').",
      arguments: z.object({ workItem: WorkItemArg }),
      execute: async (
        methodArgs: { workItem: string },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const { errors, warnings } = validateGraph(args);
        if (errors.length > 0) {
          throw new Error(
            "Definition is invalid:\n  " + errors.join("\n  "),
          );
        }
        for (const warning of warnings) {
          context.logger.warning("definition: {warning}", { warning });
        }

        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        if (view.state !== null) {
          throw new Error(
            `Work item '${workItem}' already has a run (stage '${view.state.stageId}'). ` +
              "Resume with 'status'; use 'reset' to start it over.",
          );
        }

        const initial = initialStage(args);
        if (initial === undefined) {
          throw new Error("Definition has no initial stage."); // unreachable after validateGraph
        }

        const now = new Date().toISOString();
        const hash = await definitionHash(args);
        const handles = [];
        handles.push(
          await context.writeResource("state", stateInstance(slug), {
            workItem,
            stageId: initial.id,
            cycles: { [initial.id]: 1 },
            enteredAt: now,
            status: "active",
            definitionVersion: context.definition?.version ?? 1,
            definitionHash: hash,
            startedAt: now,
          }),
        );
        handles.push(
          await writeJournal(context, workItem, slug, {
            event: "started",
            stageId: initial.id,
            summary: `Run started for '${workItem}' at stage '${initial.id}'`,
            payload: { workItem, stage: initial.id },
          }),
        );
        context.logger.info(
          "Run started for '{workItem}' at stage '{stage}'",
          { workItem, stage: initial.id },
        );
        return { dataHandles: handles };
      },
    },

    reset: {
      description:
        "Destroy a work item's run progress and re-enter the initial stage. Requires confirm=reset.",
      arguments: z.object({
        workItem: WorkItemArg,
        confirm: z.string().describe("Must be the literal string 'reset'"),
      }),
      execute: async (
        methodArgs: { workItem: string; confirm: string },
        context: Ctx,
      ) => {
        if (methodArgs.confirm !== "reset") {
          throw new Error(
            "Refusing to reset: pass confirm=reset to destroy run progress.",
          );
        }
        const { args } = await loadFactoryArgs(context);
        const { errors } = validateGraph(args);
        if (errors.length > 0) {
          throw new Error(
            "Definition is invalid:\n  " + errors.join("\n  "),
          );
        }
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const previous = view.state;

        const initial = initialStage(args);
        if (initial === undefined) {
          throw new Error("Definition has no initial stage.");
        }
        const now = new Date().toISOString();
        const hash = await definitionHash(args);
        const handles = [];
        handles.push(
          await context.writeResource("state", stateInstance(slug), {
            workItem,
            stageId: initial.id,
            cycles: { [initial.id]: 1 },
            enteredAt: now,
            status: "active",
            definitionVersion: context.definition?.version ?? 1,
            definitionHash: hash,
            startedAt: now,
          }),
        );
        handles.push(
          await writeJournal(context, workItem, slug, {
            event: "reset",
            stageId: initial.id,
            summary: previous !== null
              ? `Run reset from stage '${previous.stageId}' back to '${initial.id}'`
              : `Run reset (no prior state) to '${initial.id}'`,
            payload: { previousStage: previous?.stageId },
          }),
        );
        context.logger.info("Run for '{workItem}' reset to stage '{stage}'", {
          workItem,
          stage: initial.id,
        });
        return { dataHandles: handles };
      },
    },

    migrate: {
      description:
        "Adopt the current validated factory definition for an existing run without discarding its state, artifacts, or approvals. Refuses incompatible stage graphs instead of silently rewriting the run.",
      arguments: z.object({
        workItem: WorkItemArg,
        expectedDefinitionHash: z.string().optional().describe(
          "Optional previous definition hash; when supplied it must match the persisted run hash",
        ),
      }),
      execute: async (
        methodArgs: { workItem: string; expectedDefinitionHash?: string },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const { errors } = validateGraph(args);
        if (errors.length > 0) {
          throw new Error("Definition is invalid:\n  " + errors.join("\n  "));
        }
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const state = requireState(view, workItem);
        const currentStage = findStage(args, state.stageId);
        if (currentStage === undefined) {
          throw new Error(
            `Cannot migrate '${workItem}': persisted stage '${state.stageId}' is not present in the current definition. Restore that stage or use an explicit recovery plan; state was not changed.`,
          );
        }
        const historicalStages = Object.keys(state.cycles);
        const missingHistoricalStages = historicalStages.filter((stageId) =>
          findStage(args, stageId) === undefined
        );
        if (missingHistoricalStages.length > 0) {
          throw new Error(
            `Cannot migrate '${workItem}': the current definition removed historical stage(s) ${
              missingHistoricalStages.join(", ")
            }. Restore those stages or use an explicit recovery plan; state was not changed.`,
          );
        }
        if (
          methodArgs.expectedDefinitionHash !== undefined &&
          state.definitionHash !== methodArgs.expectedDefinitionHash
        ) {
          throw new Error(
            `Definition hash precondition failed: run has ${
              state.definitionHash ?? "none"
            }, expected ${methodArgs.expectedDefinitionHash}.`,
          );
        }
        const newHash = await definitionHash(args);
        if (state.definitionHash === newHash) {
          return { dataHandles: [] };
        }
        const oldHash = state.definitionHash;
        state.definitionHash = newHash;
        state.definitionVersion = context.definition?.version ??
          state.definitionVersion;
        const handles = [
          await context.writeResource(
            "state",
            stateInstance(slug),
            state as unknown as Record<string, unknown>,
          ),
          await writeJournal(context, workItem, slug, {
            event: "definition-migrated",
            stageId: state.stageId,
            summary: `Migrated '${workItem}' from definition ${
              oldHash ?? "none"
            } to ${newHash}`,
            payload: {
              oldHash,
              newHash,
              definitionVersion: context.definition?.version,
              stageId: state.stageId,
              cycle: state.cycles[state.stageId],
            },
          }),
        ];
        return { dataHandles: handles };
      },
    },

    resume: {
      description:
        "Resume a terminal blocked run at an explicitly named non-terminal stage without destroying its durable history. Intended for degraded recovery after a factory or environment fix.",
      arguments: z.object({
        workItem: WorkItemArg,
        targetStage: z.string().min(1),
        reason: z.string().min(1),
      }),
      execute: async (
        methodArgs: { workItem: string; targetStage: string; reason: string },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const { errors } = validateGraph(args);
        if (errors.length > 0) {
          throw new Error("Definition is invalid:\n  " + errors.join("\n  "));
        }
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const state = requireState(view, workItem);
        if (state.status !== "terminal") {
          throw new Error(
            `Run for '${workItem}' is active at '${state.stageId}'; use status/advance rather than resume.`,
          );
        }
        const target = findStage(args, methodArgs.targetStage);
        if (target === undefined || target.terminal === true) {
          throw new Error(
            `Resume target '${methodArgs.targetStage}' is not a non-terminal stage; state was not changed.`,
          );
        }
        const now = new Date().toISOString();
        state.stageId = target.id;
        state.status = "active";
        state.enteredAt = now;
        state.cycles[target.id] = (state.cycles[target.id] ?? 0) + 1;
        state.definitionHash = await definitionHash(args);
        state.definitionVersion = context.definition?.version ??
          state.definitionVersion;
        const handles = [
          await context.writeResource(
            "state",
            stateInstance(slug),
            state as unknown as Record<string, unknown>,
          ),
          await writeJournal(context, workItem, slug, {
            event: "resumed",
            stageId: target.id,
            summary:
              `Resumed '${workItem}' from terminal stage '${view.state?.stageId}' at '${target.id}'`,
            payload: {
              previousStage: view.state?.stageId,
              targetStage: target.id,
              reason: methodArgs.reason,
              definitionVersion: state.definitionVersion,
              definitionHash: state.definitionHash,
            },
          }),
        ];
        return { dataHandles: handles };
      },
    },

    record_dispatch: {
      description:
        "Record that the current stage's work is being executed — call this BEFORE dispatching subagents / running a workflow or method. It proves the stage ran (so it can't be skipped) and drives the runaway-loop guard: re-dispatching the same stage entry warns loudly, and the third attempt is rejected.",
      arguments: z.object({
        workItem: WorkItemArg,
        stageId: z.string().optional().describe(
          "The stage being executed; defaults to the current stage",
        ),
        mode: z.string().optional().describe(
          "Work mode being executed (interactive|dispatch|workflow|method)",
        ),
        runId: z.string().optional().describe(
          "Workflow/method run id, for the audit trail",
        ),
        note: z.string().optional(),
      }),
      execute: async (
        methodArgs: {
          workItem: string;
          stageId?: string;
          mode?: string;
          runId?: string;
          note?: string;
        },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const state = requireState(view, workItem);
        const handles = await noteDefinitionDrift(
          context,
          args,
          state,
          workItem,
          slug,
        );
        requireActive(state);
        const stage = requireCurrentStage(args, state);

        if (
          methodArgs.stageId !== undefined && methodArgs.stageId !== stage.id
        ) {
          throw new Error(
            `Cannot dispatch stage '${methodArgs.stageId}': the run for '${workItem}' is at stage '${stage.id}'.`,
          );
        }
        if (stage.work === undefined) {
          throw new Error(
            `Stage '${stage.id}' has no work to dispatch.`,
          );
        }

        const cycle = currentCycle(state);
        // A human may expand this entry's budget one dispatch at a time via
        // approve gateId=dispatch-override:<stage> — the recovery path when
        // an attempt was consumed by a dispatch that never actually ran.
        const limit = maxDispatchesFor(stage) +
          approvedDispatchOverrides(view, stage.id, cycle);
        const attempt = dispatchAttempts(state, stage.id, cycle) + 1;

        // Hard stop: the runaway-loop guard. Don't write — the previous
        // attempts are already journaled; surface the diagnostics and refuse.
        if (attempt > limit) {
          const diag = await stageExecutionDiagnostics(
            context,
            args,
            state,
            view,
            workItem,
            slug,
            stage,
          );
          throw new Error(
            formatDispatchFeedback(stage, cycle, attempt, limit, diag, true),
          );
        }

        const newState: RunState = {
          ...state,
          dispatches: {
            ...(state.dispatches ?? {}),
            [stage.id]: { cycle, count: attempt },
          },
        };
        handles.push(
          await context.writeResource(
            "state",
            stateInstance(slug),
            newState as unknown as Record<string, unknown>,
          ),
        );
        handles.push(
          await writeJournal(context, workItem, slug, {
            event: "dispatched",
            stageId: stage.id,
            summary:
              `Dispatched stage '${stage.id}' (attempt ${attempt}/${limit}` +
              (methodArgs.mode !== undefined
                ? `, mode ${methodArgs.mode}`
                : "") +
              ")",
            payload: {
              stageId: stage.id,
              cycle,
              attempt,
              mode: methodArgs.mode,
              runId: methodArgs.runId,
            },
          }),
        );

        // Repeat dispatch within the cap: record it, but feed back loudly.
        if (attempt > 1) {
          const diag = await stageExecutionDiagnostics(
            context,
            args,
            state,
            view,
            workItem,
            slug,
            stage,
          );
          context.logger.warning("{feedback}", {
            feedback: formatDispatchFeedback(
              stage,
              cycle,
              attempt,
              limit,
              diag,
              false,
            ),
          });
        }
        context.logger.info(
          "Dispatched stage '{stage}' for '{workItem}' (attempt {attempt}/{limit})",
          { stage: stage.id, workItem, attempt, limit },
        );
        return { dataHandles: handles };
      },
    },

    record_artifact: {
      description:
        "Record (or re-record) an artifact declared on the work item's current stage. Payload is validated against the declared schema.",
      arguments: z.object({
        workItem: WorkItemArg,
        name: z.string().describe(
          "Artifact name declared on the current stage",
        ),
        payload: z.union([
          z.record(z.string(), z.unknown()),
          z.string(),
        ]).describe("JSON object payload (or a JSON string)"),
        note: z.string().optional(),
      }),
      execute: async (
        methodArgs: {
          workItem: string;
          name: string;
          payload: Record<string, unknown> | string;
          note?: string;
        },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const state = requireState(view, workItem);
        const handles = await noteDefinitionDrift(
          context,
          args,
          state,
          workItem,
          slug,
        );
        requireActive(state);
        const stage = requireCurrentStage(args, state);

        const spec = (stage.artifacts ?? []).find(
          (a) => a.name === methodArgs.name,
        );
        if (spec === undefined) {
          const names = (stage.artifacts ?? []).map((a) => a.name).join(", ") ||
            "(none)";
          throw new Error(
            `Artifact '${methodArgs.name}' is not declared on stage '${stage.id}'. Declared: ${names}`,
          );
        }

        const payload = normalizePayload(methodArgs.payload);
        const issues = validateArtifactPayload(spec, payload);
        if (issues !== null) {
          await recordValidationFailure(context, slug, {
            target: spec.name,
            targetKind: "artifact",
            workItem,
            stageId: state.stageId,
            cycle: currentCycle(state),
            attempt: dispatchAttempts(
              state,
              state.stageId,
              currentCycle(state),
            ),
            cleared: false,
            rejected: payload,
            errors: issues,
            recordedAt: new Date().toISOString(),
          });
          throw new Error(
            `Artifact '${spec.name}' payload is invalid:\n  ` +
              issues.join("\n  "),
          );
        }

        let subjectVersion: number | undefined;
        if (spec.reviews !== undefined) {
          const subject = view.artifacts.get(spec.reviews);
          if (subject === undefined) {
            throw new Error(
              `Artifact '${spec.name}' reviews '${spec.reviews}', which has not been recorded yet.`,
            );
          }
          subjectVersion = subject.version;
        }

        const envelope: ArtifactEnvelope = {
          name: spec.name,
          workItem,
          stageId: state.stageId,
          cycle: currentCycle(state),
          payload,
          subjectVersion,
          recordedAt: new Date().toISOString(),
          note: methodArgs.note,
        };
        const written = await context.writeResource(
          "artifact",
          artifactInstance(slug, spec.name),
          envelope as unknown as Record<string, unknown>,
        );
        handles.push(written);
        handles.push(
          await writeJournal(context, workItem, slug, {
            event: "artifact_recorded",
            stageId: state.stageId,
            summary: `Recorded artifact '${spec.name}'` +
              (subjectVersion !== undefined
                ? ` (reviews ${spec.reviews} v${subjectVersion})`
                : ""),
            // version pins the journal event to the exact record written,
            // so the summary report never has to correlate by ordinal.
            payload: {
              name: spec.name,
              subjectVersion,
              version: written.version,
            },
          }),
        );
        const clearedArtifact = await clearValidationIfOpen(
          context,
          view,
          slug,
          spec.name,
          state,
        );
        if (clearedArtifact !== undefined) handles.push(clearedArtifact);
        context.logger.info("Recorded artifact '{name}' for '{workItem}'", {
          name: spec.name,
          workItem,
        });
        return { dataHandles: handles };
      },
    },

    record_evidence: {
      description:
        "Record opaque external evidence declared on the work item's current stage (PR URL, CI outcome, release link).",
      arguments: z.object({
        workItem: WorkItemArg,
        name: z.string().describe(
          "Evidence name declared on the current stage",
        ),
        payload: z.union([
          z.record(z.string(), z.unknown()),
          z.string(),
        ]).describe("JSON object payload (or a JSON string)"),
      }),
      execute: async (
        methodArgs: {
          workItem: string;
          name: string;
          payload: Record<string, unknown> | string;
        },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const state = requireState(view, workItem);
        const handles = await noteDefinitionDrift(
          context,
          args,
          state,
          workItem,
          slug,
        );
        requireActive(state);
        const stage = requireCurrentStage(args, state);

        const declared = stageEvidenceNames(stage);
        if (!declared.includes(methodArgs.name)) {
          throw new Error(
            `Evidence '${methodArgs.name}' is not declared on stage '${stage.id}'. Declared: ${
              declared.join(", ") || "(none)"
            }`,
          );
        }

        const payload = normalizePayload(methodArgs.payload);

        // Validate against the evidence's contract: an explicit declared
        // schema if the stage declares one, otherwise the built-in outcome
        // schema for the stage's resultEvidence. This is what turns "workflow
        // succeeded but recorded nothing" from a silent re-dispatch loop into
        // a loud, diagnosable failure at the write.
        const explicitSpec = (stage.evidence ?? []).find(
          (e) => e.name === methodArgs.name,
        );
        const issues = explicitSpec?.schema !== undefined
          ? validateDeclaredPayload(explicitSpec.schema, payload)
          : stage.work?.resultEvidence === methodArgs.name
          ? validateOutcomePayload(payload)
          : null;
        if (issues !== null) {
          await recordValidationFailure(context, slug, {
            target: methodArgs.name,
            targetKind: "evidence",
            workItem,
            stageId: state.stageId,
            cycle: currentCycle(state),
            attempt: dispatchAttempts(
              state,
              state.stageId,
              currentCycle(state),
            ),
            cleared: false,
            rejected: payload,
            errors: issues,
            recordedAt: new Date().toISOString(),
          });
          throw new Error(
            `Evidence '${methodArgs.name}' payload is invalid:\n  ` +
              issues.join("\n  "),
          );
        }

        const written = await context.writeResource(
          "evidence",
          evidenceInstance(slug, methodArgs.name),
          {
            name: methodArgs.name,
            workItem,
            stageId: state.stageId,
            cycle: currentCycle(state),
            payload,
            recordedAt: new Date().toISOString(),
          },
        );
        handles.push(written);
        handles.push(
          await writeJournal(context, workItem, slug, {
            event: "evidence_recorded",
            stageId: state.stageId,
            summary: `Recorded evidence '${methodArgs.name}'`,
            payload: { name: methodArgs.name, version: written.version },
          }),
        );
        const clearedEvidence = await clearValidationIfOpen(
          context,
          view,
          slug,
          methodArgs.name,
          state,
        );
        if (clearedEvidence !== undefined) handles.push(clearedEvidence);
        context.logger.info("Recorded evidence '{name}' for '{workItem}'", {
          name: methodArgs.name,
          workItem,
        });
        return { dataHandles: handles };
      },
    },

    resolve_findings: {
      description:
        "Mark findings on a kind: findings artifact as resolved, with notes.",
      arguments: z.object({
        workItem: WorkItemArg,
        artifact: z.string(),
        resolutions: z.array(
          z.object({
            findingId: z.string(),
            note: z.string().describe("How the finding was addressed"),
          }),
        ).min(1),
      }),
      execute: async (
        methodArgs: {
          workItem: string;
          artifact: string;
          resolutions: { findingId: string; note: string }[];
        },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const state = requireState(view, workItem);
        const handles = await noteDefinitionDrift(
          context,
          args,
          state,
          workItem,
          slug,
        );
        requireActive(state);

        const found = findArtifactSpec(args, methodArgs.artifact);
        if (found === undefined || found.spec.kind !== "findings") {
          throw new Error(
            `'${methodArgs.artifact}' is not a declared kind: findings artifact.`,
          );
        }
        const recorded = view.artifacts.get(methodArgs.artifact);
        if (recorded === undefined) {
          throw new Error(
            `Findings artifact '${methodArgs.artifact}' has not been recorded.`,
          );
        }

        const payload = recorded.latest.payload as {
          findings?: {
            id: string;
            resolved?: boolean;
            resolutionNote?: string;
          }[];
        };
        const findings = payload.findings ?? [];
        const byId = new Map(findings.map((f) => [f.id, f]));
        for (const resolution of methodArgs.resolutions) {
          if (!byId.has(resolution.findingId)) {
            const ids = findings.map((f) => f.id).join(", ") || "(none)";
            throw new Error(
              `Finding '${resolution.findingId}' does not exist in '${methodArgs.artifact}'. Known: ${ids}`,
            );
          }
        }
        const resolutionMap = new Map(
          methodArgs.resolutions.map((r) => [r.findingId, r.note]),
        );
        const updated = findings.map((f) => {
          const note = resolutionMap.get(f.id);
          return note !== undefined
            ? { ...f, resolved: true, resolutionNote: note }
            : f;
        });

        // Keep the original recording provenance: resolutions update content
        // without counting as a fresh recording (recordedThisCycle gates).
        const envelope = {
          ...recorded.latest,
          payload: { ...payload, findings: updated },
          resolvedAt: new Date().toISOString(),
        };
        const written = await context.writeResource(
          "artifact",
          artifactInstance(slug, methodArgs.artifact),
          envelope as unknown as Record<string, unknown>,
        );
        handles.push(written);
        handles.push(
          await writeJournal(context, workItem, slug, {
            event: "findings_resolved",
            stageId: state.stageId,
            summary:
              `Resolved ${methodArgs.resolutions.length} finding(s) in '${methodArgs.artifact}'`,
            payload: {
              artifact: methodArgs.artifact,
              resolutions: methodArgs.resolutions,
              version: written.version,
            },
          }),
        );
        context.logger.info(
          "Resolved {count} finding(s) in '{artifact}' for '{workItem}'",
          {
            count: methodArgs.resolutions.length,
            artifact: methodArgs.artifact,
            workItem,
          },
        );
        return { dataHandles: handles };
      },
    },

    mint_authority_challenge: {
      description:
        "Mint an immutable, engine-bound, NON-AUTHORIZING challenge for the current exact approval subject. This is a prerequisite record only; it cannot approve a gate or authorize work.",
      arguments: z.strictObject({
        workItem: WorkItemArg,
        gateId: z.string(),
        transition: TransitionArg,
      }),
      execute: async (
        methodArgs: { workItem: string; gateId: string; transition?: string },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const slug = workItemSlug(methodArgs.workItem);
        const view = await viewFor(context, slug, methodArgs.workItem);
        const state = requireState(view, methodArgs.workItem);
        requireActive(state);
        const definition = definitionIdentity(context);
        if (definition === undefined) {
          throw new Error(
            "Cannot mint authority challenge without exact definition identity",
          );
        }
        let challengeGates = approvalGatesInScope(
          args,
          state.stageId,
          methodArgs.gateId,
        );
        if (methodArgs.transition !== undefined) {
          challengeGates = challengeGates.filter((entry) =>
            entry.transition.name === methodArgs.transition
          );
        }
        if (challengeGates.length === 0) {
          throw new Error(
            `No human-approval '${methodArgs.gateId}' challenge policy is available` +
              (methodArgs.transition === undefined
                ? ""
                : ` for transition '${methodArgs.transition}'`),
          );
        }
        const challengePolicies = await Promise.all(challengeGates.map(
          async (entry) => ({
            transition: entry.transition.name,
            minApprovals: entry.gate.config.minApprovals ?? 1,
            contract: await computeApprovalSubjectContract({
              gateId: methodArgs.gateId,
              transition: entry.transition.name,
              subject: entry.gate.config.subject ?? {},
            }),
          }),
        ));
        const firstPolicy = challengePolicies[0];
        if (
          challengePolicies.some((policy) =>
            policy.transition !== firstPolicy.transition ||
            policy.minApprovals !== firstPolicy.minApprovals ||
            policy.contract.version !== firstPolicy.contract.version ||
            policy.contract.digest !== firstPolicy.contract.digest
          )
        ) {
          throw new Error(
            `Human-approval '${methodArgs.gateId}' has multiple challenge policies from stage ` +
              `'${state.stageId}'; pass transition=<name> to select the exact policy.`,
          );
        }
        const subject = await subjectForDecision(
          context,
          args,
          state,
          view,
          methodArgs.workItem,
          { ...methodArgs, transition: firstPolicy.transition },
        );
        if (subject === undefined) {
          throw new Error(
            `Cannot mint authority challenge for unbound or unavailable human-approval '${methodArgs.gateId}'`,
          );
        }
        const minApprovals = firstPolicy.minApprovals;
        const contract = await computeApprovalSubjectContract({
          gateId: methodArgs.gateId,
          transition: subject.transition,
          subject: subject.spec,
        });
        const event = await mintAuthorityChallengeEvent({
          identity: {
            modelType: "@mgreten/software-factory",
            modelId: context.modelId,
            modelInstanceName: definition.name,
            definitionName: definition.name,
            definitionVersion: definition.version,
            definitionHash: await definitionHash(args),
            workItem: methodArgs.workItem,
            stageId: state.stageId,
            cycle: currentCycle(state),
            runEra: state.startedAt,
            gateId: methodArgs.gateId,
            transition: subject.transition,
          },
          subject,
          policy: {
            type: "human-approval",
            minApprovals,
            subjectContractVersion: contract.version,
            subjectContractDigest: contract.digest,
          },
        });
        const expected: ChallengeExpected = {
          resourceName: event.instanceName,
          modelType: "@mgreten/software-factory",
          modelId: context.modelId,
          modelInstanceName: definition.name,
          definitionName: definition.name,
          definitionVersion: definition.version,
          definitionHash: await definitionHash(args),
          workItem: methodArgs.workItem,
          stageId: state.stageId,
          cycle: currentCycle(state),
          runEra: state.startedAt,
          gateId: methodArgs.gateId,
          transition: subject.transition,
          subject: subject.spec,
          minApprovals,
        };
        await validateAuthorityChallengeEvent(event, expected);
        const handle = await persistAuthorityChallenge(
          context,
          event,
          expected,
        );
        return { dataHandles: [handle] };
      },
    },

    approve: {
      description:
        "Record a human approval for a human-approval gate or a cycle-override. When the gate declares a subject, the approval is bound to a digest of exactly those artifact/evidence records, so a later mutation invalidates it. Only call on explicit human instruction.",
      arguments: z.object({
        workItem: WorkItemArg,
        gateId: z.string(),
        actor: z.string().describe("Who approved (a human identity)"),
        note: z.string().optional(),
        transition: TransitionArg,
      }),
      execute: async (
        methodArgs: {
          workItem: string;
          gateId: string;
          actor: string;
          note?: string;
          transition?: string;
        },
        context: Ctx,
      ) => {
        return await recordDecision(context, {
          ...methodArgs,
          decision: "approved",
        });
      },
    },

    reject: {
      description:
        "Record a human rejection for a human-approval gate, with a reason. When the gate declares a subject, the rejection is bound to that exact subject — reworking it clears the block; re-seeking approval on the same subject does not.",
      arguments: z.object({
        workItem: WorkItemArg,
        gateId: z.string(),
        actor: z.string(),
        note: z.string().describe("Why this was rejected"),
        transition: TransitionArg,
      }),
      execute: async (
        methodArgs: {
          workItem: string;
          gateId: string;
          actor: string;
          note: string;
          transition?: string;
        },
        context: Ctx,
      ) => {
        return await recordDecision(context, {
          ...methodArgs,
          decision: "rejected",
        });
      },
    },

    advance: {
      description:
        "Move a work item along a named transition. Gates are evaluated in pre-flight checks and re-validated here.",
      arguments: z.object({
        workItem: WorkItemArg,
        transition: z.string(),
      }),
      execute: async (
        methodArgs: { workItem: string; transition: string },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        const state = requireState(view, workItem);
        const handles = await noteDefinitionDrift(
          context,
          args,
          state,
          workItem,
          slug,
        );
        requireActive(state);
        const stage = requireCurrentStage(args, state);
        const transition = resolveTransition(
          args,
          stage,
          methodArgs.transition,
        );

        // Defense in depth: re-validate gates even though the
        // gates-satisfied check already ran (checks are skippable;
        // this is not).
        const evaluated = await evaluateTransitionGates(
          transition,
          gateContextFrom(context, args, state, view, workItem, slug),
        );
        if (!evaluated.pass) {
          throw new Error(
            `Transition '${transition.name}' is blocked:\n  ` +
              formatGateFailures(evaluated.results),
          );
        }

        // Defense in depth: the stage's work must have run through the factory
        // (checks are skippable; this is not).
        if (
          requiresDispatch(args, stage, transition.name) &&
          dispatchAttempts(state, stage.id, currentCycle(state)) < 1
        ) {
          throw new Error(stageNotExecutedError(stage.id, workItem));
        }

        const limit = cycleLimitFor(args, view, state, transition.to);
        if (!limit.allowed) {
          throw new Error(cycleLimitError(transition.to, limit));
        }

        const target = findStage(args, transition.to);
        if (target === undefined) {
          throw new Error(`Target stage '${transition.to}' does not exist.`);
        }
        const now = new Date().toISOString();
        const newState: RunState = {
          workItem,
          stageId: target.id,
          cycles: {
            ...state.cycles,
            [target.id]: entriesInto(state, target.id) + 1,
          },
          // Dispatch counters are cycle-scoped, so the target stage's stale
          // counter (from an earlier entry) is ignored on the new entry; carry
          // the map forward for audit rather than wiping other stages' counts.
          dispatches: state.dispatches,
          enteredAt: now,
          status: target.terminal === true ? "terminal" : "active",
          definitionVersion: state.definitionVersion,
          definitionHash: state.definitionHash,
          startedAt: state.startedAt,
        };
        handles.push(
          await context.writeResource(
            "state",
            stateInstance(slug),
            newState as unknown as Record<string, unknown>,
          ),
        );
        handles.push(
          await writeJournal(context, workItem, slug, {
            event: target.terminal === true ? "run_terminal" : "advanced",
            stageId: target.id,
            summary:
              `Advanced '${transition.name}': ${stage.id} → ${target.id}` +
              (target.terminal === true ? " (terminal)" : ""),
            payload: {
              transition: transition.name,
              from: stage.id,
              to: target.id,
              cycle: newState.cycles[target.id],
            },
          }),
        );
        context.logger.info(
          "Advanced '{transition}' for '{workItem}': {from} -> {to}{terminal}",
          {
            transition: transition.name,
            workItem,
            from: stage.id,
            to: target.id,
            terminal: target.terminal === true ? " (terminal)" : "",
          },
        );
        return { dataHandles: handles };
      },
    },

    status: {
      description:
        "What is required right now for a work item — or, without workItem, an overview of every run on this factory.",
      kind: "read" as const,
      arguments: z.object({
        workItem: WorkItemArg.optional(),
      }),
      execute: async (
        methodArgs: { workItem?: string },
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);

        // The status view is persisted as a queryable record rather than
        // dumped to a log line: the driver reads exactly the fields it needs
        // with `swamp data query --select 'attributes.<field>'`, instead of
        // scraping and re-parsing a maximal JSON blob out of log output. Each
        // call refreshes the record (it is a read-time materialized view, not
        // history — see the `status` resource's garbageCollection).
        if (methodArgs.workItem === undefined) {
          const states = await loadAllRunStates(
            context.dataRepository,
            context.modelType,
            context.modelId,
          );
          const runs = states.map((s) => ({
            workItem: s.workItem,
            stageId: s.stageId,
            status: s.status,
            cycle: s.cycles[s.stageId] ?? 1,
            startedAt: s.startedAt,
          }));
          context.logger.info(
            "{count} run(s) on this factory — query 'status-_factory' for the overview",
            { count: runs.length },
          );
          const handle = await context.writeResource(
            "status",
            statusInstance(OVERVIEW_SLUG),
            { factory: true, runs },
          );
          return { dataHandles: [handle] };
        }

        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        if (view.state === null) {
          context.logger.info(
            "No run for '{workItem}'. Run 'start' first.",
            { workItem },
          );
          const handle = await context.writeResource(
            "status",
            statusInstance(slug),
            { started: false, workItem },
          );
          return { dataHandles: [handle] };
        }
        const status = await buildStatus(
          context,
          args,
          view.state,
          view,
          workItem,
          slug,
        );
        const stage = status.stage as { id: string; cycle: number };
        const transitions = status.transitions as {
          name: string;
          satisfied: boolean;
        }[];
        const satisfied = transitions.filter((t) => t.satisfied).map((t) =>
          t.name
        );
        context.logger.info(
          "'{workItem}' at stage '{stage}' (cycle {cycle}, {runStatus}) — satisfied transitions: {satisfied}. Query 'status-{slug}' for the full view.",
          {
            workItem,
            stage: stage.id,
            cycle: stage.cycle,
            runStatus: view.state.status,
            satisfied: satisfied.join(", ") || "(none)",
            slug,
          },
        );
        const handle = await context.writeResource(
          "status",
          statusInstance(slug),
          status,
        );
        return { dataHandles: [handle] };
      },
    },

    summary: {
      description:
        "Render the full implementation history of a work item — every stage visit, artifact version, finding, approval, and transition — as a markdown report built statically from the recorded run data.",
      kind: "read" as const,
      arguments: z.object({ workItem: WorkItemArg }),
      execute: async (
        methodArgs: { workItem: string },
        context: Ctx,
      ) => {
        const workItem = methodArgs.workItem;
        const slug = workItemSlug(workItem);
        const view = await viewFor(context, slug, workItem);
        requireState(view, workItem);

        // The definition only supplies cosmetic context (the reviews map);
        // a broken or missing definition must not block an audit render.
        let reviews = new Map<string, string>();
        try {
          const { args } = await loadFactoryArgs(context);
          reviews = reviewsFromStages(args.stages);
        } catch {
          // render without subject names
        }

        // History needs every record version. Prefer the data query
        // catalog (referencing `version` opts into history; scoped by
        // modelName since the predicate language has no modelId); fall
        // back to listVersions where no query binding exists.
        const queryData = queryDataFrom(context);
        const selfName = context.definition?.name;
        const reader = queryData !== undefined && selfName !== undefined
          ? queryRunDataReader({
            queryData: (predicate) => queryData(predicate),
            dataRepository: context.dataRepository,
            modelType: context.modelType,
            modelId: context.modelId,
            modelName: selfName,
          })
          : repositoryRunDataReader({
            dataRepository: context.dataRepository,
            modelType: context.modelType,
            modelId: context.modelId,
          });
        const { timeline, markdown } = await buildWorkItemSummary(
          reader,
          workItem,
          slug,
          { factoryName: context.definition?.name, reviews },
        );
        context.logger.info("{markdown}", { markdown });
        context.logger.info("SUMMARY_JSON {summary}", {
          summary: JSON.stringify(timeline),
        });
        return { dataHandles: [] };
      },
    },

    validate: {
      description:
        "Lint the definition: meta-schema + graph rules. Fails when errors exist.",
      kind: "read" as const,
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        const { errors, warnings } = validateGraph(args);
        for (const warning of warnings) {
          context.logger.warning("warning: {warning}", { warning });
        }
        if (errors.length > 0) {
          throw new Error(
            "Definition is invalid:\n  " + errors.join("\n  "),
          );
        }
        context.logger.info(
          "Definition is valid ({stages} stages{warnings})",
          {
            stages: args.stages.length,
            warnings: warnings.length > 0
              ? `, ${warnings.length} warning(s)`
              : "",
          },
        );
        return { dataHandles: [] };
      },
    },

    describe: {
      description:
        "Render the state machine (Mermaid) plus stage/transition tables.",
      kind: "read" as const,
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: Ctx,
      ) => {
        const { args } = await loadFactoryArgs(context);
        context.logger.info("{mermaid}", { mermaid: renderMermaid(args) });
        context.logger.info("{tables}", { tables: renderTables(args) });
        return { dataHandles: [] };
      },
    },
  },
};

async function recordDecision(
  context: Ctx,
  decision: {
    workItem: string;
    gateId: string;
    actor: string;
    note?: string;
    transition?: string;
    decision: "approved" | "rejected";
  },
): Promise<{ dataHandles: { name: string }[] }> {
  const { args } = await loadFactoryArgs(context);
  const workItem = decision.workItem;
  const slug = workItemSlug(workItem);
  const view = await viewFor(context, slug, workItem);
  const state = requireState(view, workItem);

  const isCycleOverride = decision.gateId.startsWith(CYCLE_OVERRIDE_PREFIX);
  const isDispatchOverride = decision.gateId.startsWith(
    DISPATCH_OVERRIDE_PREFIX,
  );
  const isOverride = isCycleOverride || isDispatchOverride;
  const recoveryFields = decision.decision === "approved" && isOverride
    ? validateRecoveryApprovalNote(decision)
    : undefined;

  const handles = await noteDefinitionDrift(
    context,
    args,
    state,
    workItem,
    slug,
  );
  requireActive(state);

  const knownIds = allApprovalGateIds(args);
  if (isCycleOverride) {
    const stageId = decision.gateId.slice(CYCLE_OVERRIDE_PREFIX.length);
    if (findStage(args, stageId) === undefined) {
      throw new Error(
        `Cycle override targets unknown stage '${stageId}'.`,
      );
    }
  } else if (isDispatchOverride) {
    const stageId = decision.gateId.slice(DISPATCH_OVERRIDE_PREFIX.length);
    if (findStage(args, stageId) === undefined) {
      throw new Error(
        `Dispatch override targets unknown stage '${stageId}'.`,
      );
    }
  } else if (!knownIds.has(decision.gateId)) {
    const ids = [...knownIds].join(", ") || "(none)";
    throw new Error(
      `'${decision.gateId}' is not a human-approval gate in this definition. Known: ${ids}`,
    );
  }

  // Bind the decision to what is being decided *on*, when the gate says so.
  // The subject is computed here, from recorded data — never supplied by the
  // caller — so a decision can only ever attest to what the factory itself
  // sees. Cycle overrides are structural (they grant an entry, not a product)
  // and carry no subject.
  const subject = isOverride
    ? undefined
    : await subjectForDecision(context, args, state, view, workItem, decision);
  const subjectContract = subject === undefined
    ? undefined
    : await computeApprovalSubjectContract({
      gateId: decision.gateId,
      transition: subject.transition,
      subject: subject.spec,
    });

  const record: ApprovalRecord = {
    gateId: decision.gateId,
    workItem,
    decision: decision.decision,
    actor: decision.actor,
    note: decision.note,
    stageId: state.stageId,
    cycle: currentCycle(state),
    decidedAt: new Date().toISOString(),
    subjectStatus: subject !== undefined ? "bound" : "unbound",
    subject: subject !== undefined
      ? {
        digest: subject.digest,
        algorithm: subject.algorithm,
        manifestVersion: subject.manifest.manifestVersion,
        manifest: subject.manifest as unknown as Record<string, unknown>,
      }
      : undefined,
    comparisonIdentity: subjectContract === undefined ? undefined : {
      transition: subject!.transition,
      runEra: state.startedAt,
      subjectContractVersion: subjectContract.version,
      subjectContractDigest: subjectContract.digest,
    },
  };
  let approvalName = approvalInstance(slug, decision.gateId);
  if (recoveryFields !== undefined) {
    // Only approved recovery grants accumulate. Identity is authorization
    // scope, not audit prose: actor and verbatim note remain on the record but
    // cannot mint another allowance for the same normalized failure.
    const scopeStageId = decision.gateId.slice(
      isCycleOverride
        ? CYCLE_OVERRIDE_PREFIX.length
        : DISPATCH_OVERRIDE_PREFIX.length,
    );
    const grantIdentity = {
      format: "override-grant-v1" as const,
      runEra: state.startedAt,
      workItem: record.workItem,
      gateId: record.gateId,
      scopeStageId,
      scopeCycle: isDispatchOverride ? record.cycle : null,
      failureSignature: recoveryFields.failureSignature,
    };
    record.recoveryGrantIdentity = grantIdentity;
    const grantDigest = await overrideGrantDigest(grantIdentity);
    approvalName = overrideApprovalInstance(slug, decision.gateId, grantDigest);

    // Fail closed if the deterministic name is already occupied by different
    // content (hash collision or corrupt/manual write). An exact retry is safe:
    // it may create another version, but latest-only readers still count one
    // logical grant.
    const existing = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      approvalName,
    );
    if (existing !== null) {
      const parsed = ApprovalRecordSchema.safeParse(
        JSON.parse(new TextDecoder().decode(existing)),
      );
      const same = parsed.success && parsed.data.decision === "approved" &&
        canonicalJson(parsed.data.recoveryGrantIdentity) ===
          canonicalJson(grantIdentity);
      if (!same) {
        throw new Error(
          `Recovery grant identity collision at '${approvalName}'; refusing to overwrite it.`,
        );
      }
    }
  }
  handles.push(
    await context.writeResource(
      "approval",
      approvalName,
      record as unknown as Record<string, unknown>,
    ),
  );
  handles.push(
    await writeJournal(context, workItem, slug, {
      event: decision.decision,
      stageId: state.stageId,
      summary: `${decision.actor} ${decision.decision} '${decision.gateId}'` +
        (subject !== undefined
          ? ` (subject ${shortDigest(subject.digest)})`
          : "") +
        (decision.note !== undefined ? `: ${decision.note}` : ""),
      payload: {
        gateId: decision.gateId,
        actor: decision.actor,
        note: decision.note,
        // The journal is the durable audit: record what was bound, not just
        // that something was. The manifest lives on the approval record.
        subjectStatus: record.subjectStatus,
        subjectDigest: subject?.digest,
        subjectAlgorithm: subject?.algorithm,
        subjectManifestVersion: subject?.manifest.manifestVersion,
      },
    }),
  );
  context.logger.info(
    "{actor} {decision} '{gateId}' for '{workItem}'{binding}",
    {
      actor: decision.actor,
      decision: decision.decision,
      gateId: decision.gateId,
      workItem,
      binding: subject !== undefined
        ? ` bound to ${describeSubject(subject.spec)} (subject ${
          shortDigest(subject.digest)
        })`
        : "",
    },
  );
  return { dataHandles: handles };
}

const MAX_RECOVERY_NOTE_LENGTH = 1024;
const GENERIC_ASSENT = new Set(["approve", "approved", "yes"]);

/**
 * Recovery approval grammar (persisted verbatim after validation):
 *
 *   gateId=<exact gate id>; failureSignature=<nonblank correlation value>
 *
 * Whitespace around fields is insignificant. Keys are case-sensitive;
 * duplicate and unknown keys are rejected. A failureSignature is deliberately
 * opaque to this generic engine: it proves the human named a failure, but only
 * a product-specific contract can validate that value against evidence.
 */
function validateRecoveryApprovalNote(
  decision: { gateId: string; note?: string },
): { gateId: string; failureSignature: string } {
  const note = decision.note;
  if (note === undefined || note.trim().length === 0) {
    throw new Error(
      `Recovery approval '${decision.gateId}' requires a structured note.`,
    );
  }
  if (note.length > MAX_RECOVERY_NOTE_LENGTH) {
    throw new Error(
      `Recovery approval note exceeds ${MAX_RECOVERY_NOTE_LENGTH} characters.`,
    );
  }
  const assent = note.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  if (GENERIC_ASSENT.has(assent)) {
    throw new Error(
      `Recovery approval note cannot be generic assent; use the structured gateId grammar.`,
    );
  }

  const fields = new Map<string, string>();
  for (const rawPart of note.split(";")) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    if (part.length === 0 || separator <= 0) {
      throw new Error(
        `Malformed recovery approval note; expected semicolon-delimited key=value fields.`,
      );
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (value.length === 0) {
      throw new Error(`Recovery approval note field '${key}' cannot be blank.`);
    }
    if (fields.has(key)) {
      throw new Error(`Duplicate recovery approval note field '${key}'.`);
    }
    if (!["gateId", "failureSignature"].includes(key)) {
      throw new Error(`Unknown recovery approval note field '${key}'.`);
    }
    fields.set(key, value);
  }

  if (fields.get("gateId") !== decision.gateId) {
    throw new Error(
      `Recovery approval note must include exact gateId=${decision.gateId}.`,
    );
  }
  if (!fields.has("failureSignature")) {
    throw new Error(
      `Recovery approval '${decision.gateId}' requires failureSignature.`,
    );
  }
  if (fields.size !== 2) {
    throw new Error(
      `Recovery approval note must contain exactly gateId and failureSignature.`,
    );
  }
  return {
    gateId: fields.get("gateId")!,
    failureSignature: fields.get("failureSignature")!,
  };
}

/**
 * The subject a decision binds to, or undefined when the gate is unbound.
 *
 * Resolution is scoped to the gates reachable from the run's *current* stage:
 * a decision recorded now can only ever be consumed by one of those, so those
 * are the configs it must agree with. When several disagree, we refuse rather
 * than pick — an approval bound to the wrong subject is worse than no approval.
 */
async function subjectForDecision(
  context: Ctx,
  args: FactoryArguments,
  state: RunState,
  view: RunView,
  workItem: string,
  decision: { gateId: string; transition?: string },
): Promise<
  | (ApprovalSubject & { spec: ApprovalSubjectSpec; transition: string })
  | undefined
> {
  let inScope = approvalGatesInScope(args, state.stageId, decision.gateId);

  if (decision.transition !== undefined) {
    const narrowed = inScope.filter(
      (g) => g.transition.name === decision.transition,
    );
    if (narrowed.length === 0) {
      const names = inScope.map((g) => g.transition.name).join(", ") ||
        "(none)";
      throw new Error(
        `Transition '${decision.transition}' does not gate on human-approval ` +
          `'${decision.gateId}' from stage '${state.stageId}'. ` +
          `Transitions gating on it: ${names}.`,
      );
    }
    inScope = narrowed;
  }

  // The gate isn't reachable from here (e.g. approving ahead of time, or an id
  // only used by a later stage). There is no subject config to apply, so the
  // decision records unbound — and a subject-bound gate will not accept it,
  // which is the fail-closed behavior we want.
  if (inScope.length === 0) return undefined;

  const { spec, ambiguous } = resolveSubjectSpec(inScope);
  if (ambiguous.length > 0) {
    throw new Error(
      `Human-approval '${decision.gateId}' is gated with different subject ` +
        `configurations on transitions ${ambiguous.join(", ")} from stage ` +
        `'${state.stageId}', so this decision would be ambiguous. Pass ` +
        `transition=<name> to bind it to one of them, or fix the definition ` +
        `to use one subject per approval id.`,
    );
  }
  if (spec === undefined) return undefined;

  const computed = await computeApprovalSubject({
    gateId: decision.gateId,
    subject: spec,
    workItem,
    state,
    view,
    definition: definitionIdentity(context),
  });
  if (computed.missing.length > 0) {
    const names = computed.missing
      .map((m) => `${m.kind} '${m.name}'`)
      .join(", ");
    throw new Error(
      `Cannot decide '${decision.gateId}': it binds to ${
        describeSubject(spec)
      }, but ${names} has not been recorded. ` +
        `Record the subject first — an approval must name what it approves.`,
    );
  }
  // Comparison identity is intentionally exact-transition even where existing
  // authorization semantics allow one identical subject to gate siblings.
  const transition = decision.transition ?? inScope[0].transition.name;
  return { ...computed, spec, transition };
}

export { celName, workItemSlug };
