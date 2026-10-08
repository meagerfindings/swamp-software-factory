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
// The factory meta-schema: what a @mgreten/software-factory definition's
// globalArguments must look like. The state machine lives here as data.
// ---------------------------------------------------------------------------

/** Names for stages, transitions, artifacts, evidence, gates. */
const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export const NameSchema = z.string().regex(
  NAME_PATTERN,
  "must be lowercase alphanumeric with '-'/'_' separators, starting with a letter",
);

/** Default re-entry limit for every stage. Never unlimited-by-omission. */
export const DEFAULT_MAX_CYCLES = 5;

/**
 * Default dispatches allowed per stage entry before the runaway-loop guard
 * hard-fails. 2 = one normal execution plus one tolerated retry; the third
 * dispatch of the same (stage, cycle) is rejected as a suspected loop.
 */
export const DEFAULT_MAX_DISPATCHES = 2;

/** Reserved approval-id prefix for cycle-limit overrides. */
export const CYCLE_OVERRIDE_PREFIX = "cycle-override:";

/**
 * Approval gate-id prefix granting one extra dispatch of a stage's CURRENT
 * entry after the runaway-loop guard has tripped — the dispatch counterpart
 * of `cycle-override:`. One grant = one extra dispatch, scoped to the
 * (stage, cycle) at which it was approved; re-entering the stage does not
 * inherit it. Without this, a wasted dispatch (recorded but never executed)
 * on a stage with no self-re-entry path leaves abort as the only escape.
 */
export const DISPATCH_OVERRIDE_PREFIX = "dispatch-override:";

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

// ---------------------------------------------------------------------------
// Declarative artifact payload schemas (JSON-Schema-flavored subset,
// compiled to zod at runtime — see artifact_schema.ts)
// ---------------------------------------------------------------------------

export type DeclaredSchema = {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  properties?: Record<string, DeclaredSchema>;
  required?: string[];
  /**
   * Object payloads reject undeclared keys by default (strong-by-default).
   * Set `additionalProperties: true` on an object to allow open-ended keys —
   * the explicit escape hatch where a payload genuinely needs them.
   */
  additionalProperties?: boolean;
  items?: DeclaredSchema;
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export const DeclaredSchemaSchema: z.ZodType<DeclaredSchema> = z.lazy(() =>
  z.strictObject({
    type: z.enum([
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
    ]),
    description: z.string().optional(),
    properties: z.record(z.string(), DeclaredSchemaSchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
    items: DeclaredSchemaSchema.optional(),
    enum: z.array(z.union([z.string(), z.number()])).optional(),
    pattern: z.string().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
  })
);

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export const ArtifactExistsGateSchema = z.strictObject({
  type: z.literal("artifact-exists"),
  config: z.strictObject({
    artifact: NameSchema,
  }),
});

export const ArtifactFreshGateSchema = z.strictObject({
  type: z.literal("artifact-fresh"),
  config: z.strictObject({
    artifact: NameSchema,
    recordedThisCycle: z.boolean().optional(),
  }),
});

export const FindingsClearGateSchema = z.strictObject({
  type: z.literal("findings-clear"),
  config: z.strictObject({
    artifact: NameSchema,
    blocking: z.array(SeveritySchema).min(1),
  }),
});

/**
 * What a human approval is an approval *of*. Without it, an approval is scoped
 * only to (gateId, stageId, cycle) — so a selected artifact can be mutated
 * after the human looked at it and the same approval still satisfies the same
 * gate. With it, `approve`/`reject` bind an exact digest of the named records
 * and gate evaluation requires that digest to still match.
 *
 * Both flags default to true: the run slot (stage, cycle, era) and the
 * definition identity (name, version) are part of what was approved unless a
 * definition deliberately opts out.
 */
export const ApprovalSubjectSchema = z.strictObject({
  artifacts: z.array(NameSchema).optional().describe(
    "Artifact names whose current recorded version the approval binds to",
  ),
  evidence: z.array(NameSchema).optional().describe(
    "Evidence names whose current recorded version the approval binds to",
  ),
  includeRun: z.boolean().optional().describe(
    "Bind to the run slot — stage, cycle, and run era (default true)",
  ),
  includeDefinition: z.boolean().optional().describe(
    "Bind to the definition name and version (default true)",
  ),
}).refine(
  (subject) =>
    (subject.artifacts ?? []).length + (subject.evidence ?? []).length > 0,
  "subject must select at least one artifact or evidence name",
);

export type ApprovalSubjectSpec = z.infer<typeof ApprovalSubjectSchema>;

export const HumanApprovalGateSchema = z.strictObject({
  type: z.literal("human-approval"),
  config: z.strictObject({
    id: NameSchema,
    minApprovals: z.number().int().positive().optional(),
    /**
     * Optional exact binding of the approval to the artifacts/evidence it is
     * an approval of. Omitted, the gate keeps its original unbound semantics.
     */
    subject: ApprovalSubjectSchema.optional(),
  }),
});

export const EvidenceRecordedGateSchema = z.strictObject({
  type: z.literal("evidence-recorded"),
  config: z.strictObject({
    name: NameSchema,
    requireField: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const CooldownGateSchema = z.strictObject({
  type: z.literal("cooldown"),
  config: z.strictObject({
    afterEvidence: NameSchema.optional(),
    afterArtifact: NameSchema.optional(),
    seconds: z.number().positive(),
  }).refine(
    (c) =>
      (c.afterEvidence !== undefined ? 1 : 0) +
          (c.afterArtifact !== undefined ? 1 : 0) === 1,
    "exactly one of afterEvidence or afterArtifact is required",
  ),
});

export const MaxCyclesGateSchema = z.strictObject({
  type: z.literal("max-cycles"),
  config: z.strictObject({
    stage: NameSchema,
    limit: z.number().int().positive(),
    invert: z.boolean().optional(),
  }),
});

export const CelGateSchema = z.strictObject({
  type: z.literal("cel"),
  config: z.strictObject({
    expr: z.string().min(1),
    message: z.string().optional(),
  }),
});

export const WorkflowSucceededGateSchema = z.strictObject({
  type: z.literal("workflow-succeeded"),
  config: z.strictObject({
    workflow: z.string().min(1),
    requireStepOutputs: z.array(z.string().min(1)).optional(),
  }),
});

export const GateSchema = z.discriminatedUnion("type", [
  ArtifactExistsGateSchema,
  ArtifactFreshGateSchema,
  FindingsClearGateSchema,
  HumanApprovalGateSchema,
  EvidenceRecordedGateSchema,
  CooldownGateSchema,
  MaxCyclesGateSchema,
  CelGateSchema,
  WorkflowSucceededGateSchema,
]);

export type GateSpec = z.infer<typeof GateSchema>;

// ---------------------------------------------------------------------------
// Work modes
// ---------------------------------------------------------------------------

export const WorkflowCallSchema = z.strictObject({
  name: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

export const MethodCallSchema = z.strictObject({
  modelIdOrName: z.string().min(1),
  methodName: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).optional(),
});

export const WorkContextSchema = z.strictObject({
  inject: z.array(NameSchema).optional(),
});

export const WorkSchema = z.strictObject({
  mode: z.enum(["interactive", "dispatch", "workflow", "method"]),
  skills: z.array(z.string().min(1)).optional(),
  systemPrompt: z.string().optional(),
  command: z.string().optional(),
  constraints: z.string().optional(),
  context: WorkContextSchema.optional(),
  workflow: WorkflowCallSchema.optional(),
  method: MethodCallSchema.optional(),
  /**
   * Schema the resolved input bindings (workflow.inputs / method.inputs)
   * must satisfy before dispatch. The engine validates resolved values
   * against it and surfaces violations in `status` as `invalidInputs`, so a
   * type-drifted upstream value is caught at the boundary the factory owns.
   */
  inputsSchema: DeclaredSchemaSchema.optional(),
  resultEvidence: NameSchema.optional(),
}).superRefine((work, ctx) => {
  if (work.mode === "workflow" && work.workflow === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "mode 'workflow' requires a workflow block",
      path: ["workflow"],
    });
  }
  if (work.mode === "method" && work.method === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "mode 'method' requires a method block",
      path: ["method"],
    });
  }
  if (
    work.inputsSchema !== undefined &&
    work.mode !== "workflow" && work.mode !== "method"
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "inputsSchema only applies to mode 'workflow' or 'method' (the modes with input bindings)",
      path: ["inputsSchema"],
    });
  }
});

export type WorkSpec = z.infer<typeof WorkSchema>;

// ---------------------------------------------------------------------------
// Artifacts, evidence, transitions, stages
// ---------------------------------------------------------------------------

export const ArtifactSpecSchema = z.strictObject({
  name: NameSchema,
  description: z.string().optional(),
  kind: z.literal("findings").optional(),
  reviews: NameSchema.optional(),
  schema: DeclaredSchemaSchema.optional(),
});

export type ArtifactSpec = z.infer<typeof ArtifactSpecSchema>;

export const EvidenceSpecSchema = z.strictObject({
  name: NameSchema,
  description: z.string().optional(),
  /**
   * Payload contract for this evidence, validated on `record_evidence`.
   * Evidence is opaque to gates, but its shape is not unchecked: every
   * declared evidence carries a schema (graph validation enforces it). A
   * stage's `resultEvidence` is exempt — it inherits the engine's built-in
   * outcome schema (`{status, runId, outputs?}`) unless an explicit evidence
   * entry of the same name overrides it.
   */
  schema: DeclaredSchemaSchema.optional(),
});

export type EvidenceSpec = z.infer<typeof EvidenceSpecSchema>;

export const TransitionSchema = z.strictObject({
  name: NameSchema,
  to: NameSchema,
  description: z.string().optional(),
  manual: z.boolean().optional(),
  gates: z.array(GateSchema).optional(),
});

export type TransitionSpec = z.infer<typeof TransitionSchema>;

export const StageSchema = z.strictObject({
  id: NameSchema,
  description: z.string().optional(),
  initial: z.boolean().optional(),
  terminal: z.boolean().optional(),
  maxCycles: z.number().int().positive().optional(),
  maxDispatchesPerCycle: z.number().int().positive().optional(),
  work: WorkSchema.optional(),
  artifacts: z.array(ArtifactSpecSchema).optional(),
  evidence: z.array(EvidenceSpecSchema).optional(),
  transitions: z.array(TransitionSchema).optional(),
});

export type StageSpec = z.infer<typeof StageSchema>;

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

/**
 * Strict shape of a factory definition's globalArguments. Used internally
 * after reading the raw definition via the definition repository.
 *
 * Note there is no workItem here: one factory instance serves many work
 * items, and every method takes `workItem` as an argument. All run data is
 * namespaced per work item.
 */
export const FactoryArgumentsSchema = z.object({
  stages: z.array(StageSchema).min(1).describe(
    "The state machine: stages, work specs, artifacts, gates, transitions",
  ),
  globalTransitions: z.array(TransitionSchema).optional().describe(
    "Escape-hatch transitions available from any non-terminal stage",
  ),
});

export type FactoryArguments = z.infer<typeof FactoryArgumentsSchema>;

/**
 * Platform-facing globalArguments schema. Lenient on purpose: fields whose
 * values contain unresolved `${{ }}` expressions are stripped before the
 * platform validates, so requiring `stages` here would reject definitions
 * that embed CEL bindings. Methods re-parse the raw definition with
 * FactoryArgumentsSchema (via the definition repository) and fail with a
 * clear error when something is actually missing.
 */
export const PlatformArgumentsSchema = z.object({
  stages: z.array(z.unknown()).optional().describe(
    "The state machine: stages, work specs, artifacts, gates, transitions " +
      "(validated in full by the model — see FactoryArgumentsSchema)",
  ),
  globalTransitions: z.array(z.unknown()).optional().describe(
    "Escape-hatch transitions available from any non-terminal stage",
  ),
});

// ---------------------------------------------------------------------------
// Lookup helpers over a parsed definition
// ---------------------------------------------------------------------------

export function findStage(
  args: FactoryArguments,
  stageId: string,
): StageSpec | undefined {
  return args.stages.find((s) => s.id === stageId);
}

export function initialStage(args: FactoryArguments): StageSpec | undefined {
  return args.stages.find((s) => s.initial === true);
}

export function maxCyclesFor(stage: StageSpec): number {
  return stage.maxCycles ?? DEFAULT_MAX_CYCLES;
}

export function maxDispatchesFor(stage: StageSpec): number {
  return stage.maxDispatchesPerCycle ?? DEFAULT_MAX_DISPATCHES;
}

/** Whether a transition name refers to a global (escape-hatch) transition. */
export function isGlobalTransition(
  args: FactoryArguments,
  name: string,
): boolean {
  return (args.globalTransitions ?? []).some((t) => t.name === name);
}

/** All artifact specs across all stages, with their declaring stage id. */
export function allArtifactSpecs(
  args: FactoryArguments,
): { spec: ArtifactSpec; stageId: string }[] {
  const out: { spec: ArtifactSpec; stageId: string }[] = [];
  for (const stage of args.stages) {
    for (const spec of stage.artifacts ?? []) {
      out.push({ spec, stageId: stage.id });
    }
  }
  return out;
}

export function findArtifactSpec(
  args: FactoryArguments,
  name: string,
): { spec: ArtifactSpec; stageId: string } | undefined {
  return allArtifactSpecs(args).find((a) => a.spec.name === name);
}

/**
 * All evidence names across all stages, with their declaring stage id.
 * A stage's work.resultEvidence is an implicit evidence declaration.
 */
export function allEvidenceNames(
  args: FactoryArguments,
): { name: string; stageId: string }[] {
  const out: { name: string; stageId: string }[] = [];
  for (const stage of args.stages) {
    for (const spec of stage.evidence ?? []) {
      out.push({ name: spec.name, stageId: stage.id });
    }
    if (stage.work?.resultEvidence !== undefined) {
      out.push({ name: stage.work.resultEvidence, stageId: stage.id });
    }
  }
  return out;
}

/** Transitions available from a stage, including global transitions. */
export function transitionsFrom(
  args: FactoryArguments,
  stage: StageSpec,
): TransitionSpec[] {
  if (stage.terminal === true) return [];
  return [...(stage.transitions ?? []), ...(args.globalTransitions ?? [])];
}

/** All human-approval gate ids declared anywhere in the definition. */
export function allApprovalGateIds(args: FactoryArguments): Set<string> {
  const ids = new Set<string>();
  const collect = (transitions: TransitionSpec[]) => {
    for (const t of transitions) {
      for (const gate of t.gates ?? []) {
        if (gate.type === "human-approval") ids.add(gate.config.id);
      }
    }
  };
  for (const stage of args.stages) collect(stage.transitions ?? []);
  collect(args.globalTransitions ?? []);
  return ids;
}

/** Snake-case a declared name for use in CEL contexts. */
export function celName(name: string): string {
  return name.replaceAll("-", "_");
}
