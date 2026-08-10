# @swamp/software-factory — Design

A fully generic, model-driven state machine for guiding agents through a
software development lifecycle. Users configure **what** their factory requires
— stages, gates, artifacts, review skills, agent commands, system prompts — as
data in the model definition itself. The extension ships **no** hardcoded
lifecycle concepts: no "triage", no "plan", no "PR", no tracker coupling. Those
are all things a factory definition can express, not things the code knows
about.

## Goals

- **Model-driven**: the entire state machine — stages, transitions, gates,
  required artifacts, agent dispatch config — lives in the swamp model
  definition file (`globalArguments`), authored with `swamp model create` /
  `swamp model edit`, validated by the platform, versioned in git.
- **Generic**: the engine interprets any valid definition. Adversarial review,
  comprehensive testing, release, and UAT stages are expressible (and shipped as
  example definitions), never assumed.
- **Enforced, not advised**: gates block `advance`. An agent cannot skip a
  configured review any more than issue-lifecycle lets you approve with
  unresolved critical findings.
- **Clear extension points**: source control, CI, trackers, and notifications
  integrate through opaque _evidence_ records, `method`/`workflow` work modes
  that invoke other models, and the skill layer — the factory engine never
  embeds a client for any external system.
- **Auditable**: every method appends to an immutable journal; every artifact is
  versioned; run state records the definition version it executes under.

## Non-goals (v1)

- Parallel active stages (fan-out is modeled as N artifacts within one stage).
- User-supplied gate _code_ (a fixed, parameterized gate library instead).
- The factory engine performing external side effects itself. Side effects
  happen in agent work or in _other_ models invoked as stage work; the factory
  records artifacts and evidence and verifies them with gates.

## Architecture: one model type

There is a single model type, `@swamp/software-factory`. **An instance is a
factory that serves many work items concurrently** — create it once, run
thousands of work items through it. Every method takes `workItem` as an
argument, and all run data is namespaced per work item:

```
swamp model create @swamp/software-factory acme-sdlc
swamp model edit acme-sdlc      # fill in stages
swamp model validate acme-sdlc  # platform validates against the meta-schema
swamp model method run acme-sdlc start --input workItem=ISSUE-42
```

```
@swamp/software-factory instance
  ├── definition file (models/@swamp/software-factory/<id>.yaml)
  │     globalArguments:
  │       stages: […]          ← the entire state machine, as data
  └── resources (runtime, namespaced per work item)
        ├── state-<workItem> (current stage, cycle counts, definition version)
        ├── artifact-<workItem>-<name> (versioned, schema-validated)
        ├── evidence-<workItem>-<name> (opaque external facts)
        ├── approval-<workItem>-<gateId> (human gate decisions)
        └── journal-<workItem> (append-only audit trail)
```

Work item refs are arbitrary strings (issue ids, ticket URLs); refs that are not
data-name-safe get a deterministic hashed slug for instance naming, and every
envelope carries the original ref. Gate and binding vocabulary stays logical
(`artifact-plan`) — the engine translates to physical names per work item, so
definitions are portable and parallel runs can never collide.

There is no separate "definition-holder" model and no stored definition
resource: the state machine **is** the model definition. The platform provides
everything a separate model would have existed for:

- **Validation** — the type's `globalArguments` zod schema is the meta-schema;
  `swamp model validate` checks it natively. Graph validation (reachability,
  dangling references) runs as a pre-flight check on every method and via an
  explicit `validate` method.
- **Versioning** — definition files are git-tracked YAML with a `version` field;
  `context.definition.version` is visible to methods, so run state records which
  revision it executes under and the journal notes mid-run definition changes.
- **Reuse** — definitions can CEL-reference other models. A team keeps one
  template instance holding the canonical stage graph and other factory
  instances inherit it:

  ```yaml
  globalArguments:
    stages: "${{ model.acme-sdlc-template.definition.globalArguments.stages }}"
  ```

  Topological evaluation and cycle detection are platform behavior. Definition
  `inputs` (instantiation-time values) are a second reuse mechanism. No
  extension code needed for either.

**Mid-run definition edits take effect immediately** (there is no snapshot).
This is deliberate: the YAML is in git, the state records the version it started
under, and the journal records when the version changes. If an edit removes the
run's current stage, the graph-validity check fails every method with a clear
error until the definition is fixed — a stuck run is loud, not silent.

## The factory definition

The heart of the design: a model definition file whose `globalArguments` carry
the state machine. The walkthrough factory (plan → adversarial plan review →
implement → test → code review, with loop-backs):

```yaml
# models/@swamp/software-factory/<id>.yaml — created by `swamp model create`
type: "@swamp/software-factory"
name: acme-feature-factory
version: 1
globalArguments:
  stages:
    - id: planning
      initial: true
      work: { mode: interactive, skills: [planning] }
      artifacts: [{ name: plan, versioned: true, schema: { ... } }]
      transitions:
        - {
            name: submit,
            to: plan-review,
            gates: [{ type: artifact-exists, config: { artifact: plan } }],
          }

    - id: plan-review
      work:
        mode: dispatch
        skills: [
          architecture,
          accessibility,
        ] # one reviewer dispatched per skill
        systemPrompt: |
          Adversarially review this plan. Record findings with severities.
      artifacts: [{ name: plan-review, kind: findings, reviews: plan }]
      transitions:
        - name: approve
          to: implementing
          gates:
            - {
                type: artifact-fresh,
                config: { artifact: plan-review, recordedThisCycle: true },
              }
            - {
                type: findings-clear,
                config: { artifact: plan-review, blocking: [critical, high] },
              }
            - { type: human-approval, config: { id: plan-approval } }
        - { name: rework, to: planning } # no gates — always available

    - id: implementing
      work: {
        mode: interactive,
        skills: [implementation],
        constraints: agent-constraints/implementation.md,
      }
      artifacts: [{ name: change-summary, schema: { ... } }]
      evidence: [{ name: change-request }] # branch / sha / PR url — opaque
      transitions:
        - name: submit
          to: testing
          gates:
            - { type: artifact-exists, config: { artifact: change-summary } }
            - { type: evidence-recorded, config: { name: change-request } }

    - id: testing
      work:
        mode: workflow # deterministic — no LLM involved
        workflow: {
          name: "@acme/run-tests",
          inputs: {
            ref: '${{ data.latest(self.name, "evidence-change-request").payload.headSha }}',
          },
        }
        resultEvidence: test-run # driver records the outcome here
      transitions:
        - {
            name: pass,
            to: code-review,
            gates: [
              {
                type: evidence-recorded,
                config: { name: test-run, requireField: { status: succeeded } },
              },
            ],
          }
        - {
            name: fail,
            to: implementing,
            gates: [
              {
                type: evidence-recorded,
                config: { name: test-run, requireField: { status: failed } },
              },
            ],
          }

    - id: code-review
      work:
        mode: dispatch
        skills: [architecture, accessibility] # same skills, different subject
        systemPrompt: |
          Adversarially review the change at
          ${{ data.latest(self.name, "evidence-change-request").payload.url }}.
      artifacts: [
        { name: code-review, kind: findings, reviews: change-summary },
      ]
      transitions:
        - name: accept
          to: done
          gates:
            - {
                type: artifact-fresh,
                config: { artifact: code-review, recordedThisCycle: true },
              }
            - {
                type: findings-clear,
                config: { artifact: code-review, blocking: [critical, high] },
              }
            - { type: human-approval, config: { id: ship-approval } }
        - { name: rework, to: implementing }

    - id: done
      terminal: true

  globalTransitions: # available from any non-terminal stage
    - name: abort
      to: aborted
      gates: [{ type: human-approval, config: { id: abort-confirmation } }]
```

Everything above — the stage names, the skills lists, the system prompts, the
severity thresholds, the evidence names — is user data. A factory for docs
review, infra change management, or security response uses the same engine with
a different definition.

**One expression language.** All expressions are platform CEL in the platform's
`${{ }}` syntax — including run-data bindings, which use the platform's own data
namespace: `data.latest(self.name, "evidence-<name>")`, `data.version(...)`,
`data.query(...)`. `self.name` keeps bindings generic across instances (so they
work in CEL-shared template stages). What the engine controls is _when_ they
evaluate: bindings only ever reference data **written by earlier stages**, and
the engine evaluates them at stage execution time — by which point that data
exists — using the platform's own evaluator (`context.createCelEnvironment()`).
Until then they sit unresolved in the definition, which the platform explicitly
tolerates: unresolved `${{ }}` globalArgument fields are stripped from
validation and lazily proxy-guarded, so the engine reads its raw stage config
via `context.definitionRepository` rather than through the guarded
`globalArgs.stages`. No second evaluator, no custom sigil.

### Definition concepts

| Concept               | What it is                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **stage**             | A named state. Exactly one `initial: true`; ≥1 `terminal: true`. Every stage carries `maxCycles` (default 5) — an engine-enforced re-entry limit that parks the run for human override when tripped.                                                                                          |
| **work**              | How the stage's work gets done — one of four modes (below): agent-in-conversation, dispatched subagents, a named swamp workflow, or a model method call. Opaque to the engine; consumed by the driver.                                                                                        |
| **artifact**          | A named, schema-validated, versioned data product of a stage. **Every artifact declares a payload schema** (or `kind: findings`, which carries a built-in findings contract) — there is no unvalidated artifact. Optional `reviews: <artifact>` links it to a subject for freshness checking. |
| **evidence**          | An external fact recorded by the agent (PR URL, CI run id + status, release URL). **Carries a declared payload schema, validated on `record_evidence`** — opaque to gates, but not unchecked. The engine never fetches anything — this is the source-control/CI extension point.              |
| **transition**        | A named edge with gates. "Send back" loops are just transitions to earlier stages.                                                                                                                                                                                                            |
| **gate**              | A parameterized instance of a built-in evaluator (below). All gates on a transition must pass for `advance`.                                                                                                                                                                                  |
| **globalTransitions** | Escape hatches (abort, escalate) available from any non-terminal stage.                                                                                                                                                                                                                       |

### Work modes

Not every stage needs an LLM. The `work.mode` enum covers the spectrum from
judgment to pure mechanism:

| Mode          | Executor                                                                                                                                                        | Spec                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `interactive` | The driving agent itself, in conversation.                                                                                                                      | `skills`, `systemPrompt`, `constraints`                                                 |
| `dispatch`    | Subagent(s) spawned by the driver — one per listed skill, in parallel, findings merged into the stage's artifact. Independent perspectives, not one generalist. | + `command` template                                                                    |
| `workflow`    | A named swamp workflow (jobs/steps, JSON-Schema inputs).                                                                                                        | `workflow.name`, `workflow.inputs` bindings, `resultEvidence`                           |
| `method`      | A single model method on any swamp model.                                                                                                                       | `method.modelIdOrName`, `method.methodName`, `method.inputs` bindings, `resultEvidence` |

`method` is the degenerate single-call case of `workflow` — supported directly
so users don't have to author a wrapper workflow for one invocation. It is also
how tracker integrations work: a stage can invoke a tracker-specific model's
method (a forgejo-issue / github-issue / swamp-club model type) with
`${{ workItem }}` bound into its inputs — fetching issue context, posting status
— while the factory engine itself stays integration-free.

**Input bindings** are platform CEL over the data namespace —
`${{ data.latest(self.name, "evidence-change-request").payload.headSha }}`,
`${{ self.globalArguments.workItem }}` — evaluated by the engine at stage
execution time (see "One expression language" above). This is how a generic test
workflow learns which branch to test without knowing anything about factories,
and it composes with everything else CEL can reach (model refs, env, vault,
`data.query`).

**Outcome capture.** For `workflow`/`method` modes the driver executes, waits,
and calls `record_evidence` with the outcome (`{status, runId, outputs}`) under
the declared `resultEvidence` name. That outcome is validated against a
**built-in outcome schema** (`status` ∈ {succeeded, failed} and `runId`
required; extra keys allowed) unless an explicit evidence entry of the same name
overrides it — so a workflow that reports success but records an empty or
malformed outcome fails loudly at the write instead of leaving the gate quietly
unsatisfied (the silent re-dispatch trap). Pass/fail transitions gate on the
outcome — for swamp workflows, prefer the `workflow-succeeded` gate, which
verifies against the platform's own run records rather than the recorded
evidence; `evidence-recorded` with `requireField` remains for external
mechanisms swamp didn't execute (a remote CI system, a manual deploy). The
standard propulsion rule auto-advances whichever branch is live. The engine
stays a pure record-keeper: it never executes workflows or commands itself.

**Input validation.** A `workflow`/`method` stage may declare an `inputsSchema`.
After the engine resolves the stage's input bindings (at `status` time), it
validates the resolved values against that schema and reports any mismatch as
`invalidInputs` in the status packet. This catches an upstream value that
drifted shape — a list recorded as a markdown string, a number returned as text
— at the boundary the factory owns, before the driver forwards it into a strict
downstream method. The check is advisory (the engine never dispatches), but it
gives the driver a declared contract and a path-bearing error instead of an
opaque failure inside the called model.

**Context discovery (LLM modes).** Prior work is discoverable, not injected.
`status` always returns a context **manifest** — every artifact and evidence
record on the run, with versions, cycle provenance, and roles:

- **Lineage**: artifacts from earlier stages (the plan and its review, by the
  time you're implementing).
- **Subject**: whatever this stage `reviews:`, marked as the thing under review.
- **Own-prior**: this stage's own artifacts from earlier cycles — last round's
  findings with their claimed resolutions.

The manifest is cheap (names and versions, no payloads); fetching is the agent's
judgment call. The skill teaches retrieval via swamp's query facility — CEL
predicates with field projection, e.g.

```
swamp data query 'modelName == "payments-factory" && name == "artifact-PAY-42-plan-review"' --json
swamp data query 'modelName == "payments-factory"' --select name   # what exists
```

— and dispatch prompts include the manifest plus the retrieval recipe so
subagents pull their own context: a round-2 reviewer queries up its round-1
findings to verify the claimed resolutions, per the skill's review guidance,
rather than receiving them unconditionally. Projection (`--select`) lets an
agent pull just the fields it needs instead of whole payloads. An optional
`work.context.inject: [names]` list lets an author guarantee inclusion where a
stage always needs something (the `reviews:` subject is the typical candidate);
everything else stays pull-based.

**Self-reporting variant.** Because swamp workflows have a `model_method` task
type, a workflow's final job can instead call `record_evidence` on the run
directly. Driver-records is the default (it keeps workflows factory-agnostic and
reusable); self-reporting suits long-running workflows where parking a driver to
wait is wasteful.

### Gate library (v1)

Fixed evaluators, parameterized by config. Each returns `{pass, reasons[]}` —
the reasons become the agent-facing error from `advance`, which is what actually
steers the agent (issue-lifecycle proved these messages are the real UX).

| Gate                 | Config                                        | Passes when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifact-exists`    | `artifact`                                    | The artifact has ≥1 version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `artifact-fresh`     | `artifact`, `recordedThisCycle?`              | The artifact's recorded subject version equals the subject's current version (generalizes "review must match plan vN"). With `recordedThisCycle: true`, additionally requires the latest version to have been recorded during the current entry into this stage — re-entering the stage mechanically forces re-recording (e.g. re-review after rework), closing the loophole where `resolve_findings` notes alone could clear blockers without fresh review.                                                                                                  |
| `findings-clear`     | `artifact`, `blocking: [severities]`          | No unresolved finding at a blocking severity in the artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `human-approval`     | `id`, `minApprovals?`, `subject?`             | ≥minApprovals approval records for `id` against the current stage entry cycle. When `subject` selects artifact/evidence names, only decisions whose `approval-subject-v1` SHA-256 exactly matches the current selected envelopes and canonical payload digests count. Run era and definition identity are included by default.                                                                                                                                                                                                                                |
| `evidence-recorded`  | `name`, `requireField?`                       | Evidence `name` exists for the current stage cycle; optional field-value match (e.g. `{status: succeeded}`).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cooldown`           | `afterEvidence` \| `afterArtifact`, `seconds` | Enough wall-clock time has elapsed since the referenced record (generalizes the PR/CI cooldown).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `max-cycles`         | `stage`, `limit`, `invert?`                   | Routing only — e.g. with `invert`, an `escalate` transition becomes live after N cycles. The safety net itself is not a gate: every stage has an engine-enforced `maxCycles` (default 5, see cycle limits below) regardless of what gates a definition declares.                                                                                                                                                                                                                                                                                              |
| `workflow-succeeded` | `workflow`, `requireStepOutputs?`             | The platform's own run summary (`report-swamp-workflow-summary-json`, owned by the workflow) shows the latest run of the declared workflow succeeded, created within the current `(stage, cycle)` window — verified via `queryData`, not driver attestation. With `requireStepOutputs`, additionally verifies the named run data was written by that run (step outputs carry `workflowRunId` provenance tags). **Spike-confirmed.** Note: run summaries are GC'd (30d/5 versions) — this gate verifies fresh outcomes; the journal remains the durable audit. |
| `cel`                | `expr`, `message?`                            | The CEL predicate evaluates to `true` over materialized run data: `artifacts.<name>`, `evidence.<name>`, `state`, `approvals`, `workItem` (snake-cased names). Full CEL incl. macros — e.g. `size(artifacts.plan_review.findings.filter(f, !f.resolved && f.severity in ["critical","high"])) == 0`. `message` is the human/agent-facing reason on failure. **Spike-confirmed** on the real platform.                                                                                                                                                         |

User-supplied gate _code_ (arbitrary TS in the definition) remains out of scope;
the `cel` gate is the extensibility valve. The named gates stay as ergonomic
shorthands with first-class error messages — most factories should prefer them
and reach for `cel` only where the library falls short.

## Model surface

**globalArguments** (zod schema = the factory meta-schema, validated by the
platform at definition time):

- `stages: Stage[]`, `globalTransitions?: Transition[]` — the machine.

There is no workItem in globalArguments: every method takes `workItem: string`
(opaque ref — issue #, ticket URL, anything) and scopes all reads and writes to
that work item's namespace.

Artifact and evidence payload schemas inside `stages` are declarative
(JSON-Schema-flavored keywords:
`type/properties/required/additionalProperties/items/enum/pattern/min/max`) and
are **compiled to zod at runtime** by the engine — no separate validation
engine. The accepted keyword subset is itself enforced by the zod meta-schema,
so a definition cannot silently use keywords nothing validates. Object payloads
compile to **strict** zod objects by default — an undeclared key is rejected,
catching LLM drift at the producing seam — with `additionalProperties: true` the
per-object escape hatch.

Validation is layered and all zod: the typed resource-envelope schemas
(`RunStateSchema`, `ArtifactEnvelopeSchema`, `EvidenceEnvelopeSchema`, …)
validate envelope structure on every `writeResource`; the compiled payload
schema validates inside `record_artifact`/`record_evidence`, surfacing zod's
path-bearing errors (`steps[0].description: Required`) to the agent. The
invariant: **every datum that crosses a stage boundary has a declared schema and
is validated at the moment it is written.** Graph validation makes it structural
— a schemaless artifact or evidence is a hard error, with a message that points
the agent at the skill's authoring reference to self-correct.

**Rejections are recorded, not just thrown.** When `record_artifact` /
`record_evidence` reject a malformed payload, they first write a `validation`
record — the rejected value plus the path-bearing errors — and _then_ throw. The
platform keeps writes that precede a throw (the method-execution layer collects
persisted handles on the error path; `code-review` relies on the same "write
log, then throw on FAIL"), so the bad payload is still rejected while its
diagnosis survives as run data. That record is bindable as **retry feedback** —
`data.latest(self.name, "validation-<target>")` (bind the whole record; it's
null-safe when absent, where a sub-field access would throw and leave the input
unresolved) — so an LLM-driven stage can re-prompt its model with exactly what
failed. It is **auto-cleared** when the target next records cleanly (so a fresh
entry never binds a stale failure), surfaced in `status.validations`, and the
retry loop is bounded by the dispatch guard rather than a separate retry cap.
This is the engine's whole role in recovery: it _detects and records_ the
failure deterministically; the _re-prompting_ stays with whoever owns the model
call (driver, or the method itself via structured output), so the engine never
makes an LLM call.

**resources** (all instances namespaced by the work item's slug)

- `state` —
  `{workItem, stageId, cycles: Record<stageId, number>, dispatches?: Record<stageId, {cycle, count}>, enteredAt, status: active|terminal, definitionVersion, startedAt}`;
  instances `state-<workItem>`. `dispatches` is the per-entry dispatch counter
  the runaway-loop guard reads (cycle-scoped, so it resets on re-entry).
- `artifact` — envelope
  `{name, workItem, stageId, cycle, payload, subjectVersion?, recordedAt}`;
  instances `artifact-<workItem>-<name>`; payload validated in method code
  against the definition's declared schema for that artifact.
- `evidence` — `{name, workItem, stageId, cycle, payload, recordedAt}`;
  instances `evidence-<workItem>-<name>`; payload validated against the
  evidence's declared schema (or, for a stage's `resultEvidence`, the built-in
  outcome schema). Opaque to gates, but not unvalidated.
- `approval` —
  `{gateId, workItem, decision: approved|rejected, actor, note, stageId, cycle, subjectStatus?, subject?}`;
  subject-bound decisions persist the canonical manifest, algorithm, and digest
  while legacy records remain readable; instances
  `approval-<workItem>-<gateId>`.
- `validation` —
  `{target, targetKind, workItem, stageId, cycle, attempt, cleared, rejected?, errors, recordedAt}`;
  instances `validation-<workItem>-<target>`. A recorded payload-validation
  failure (the rejected value + path-bearing errors), written by
  `record_artifact`/`record_evidence` when they reject a malformed payload and
  re-thrown; bindable as retry feedback and auto-cleared when the target records
  cleanly. Short GC (10) — transient feedback, not durable audit.
- `journal` — append-only `{event, workItem, stageId, summary, payload, at}`;
  one versioned instance per work item. The audit trail, and the hook point for
  mirroring to trackers (a stage/skill concern, not an engine concern).

**Era filtering**: `reset` re-stamps `startedAt`; records written before it stay
in history for audit but are invisible to gates, bindings, and status — a reset
run really does start fresh, with no stale-artifact leakage.

**methods** (the entire generic surface — none of these name a lifecycle
concept)

- `start {workItem}` — validate the graph, start that work item at the initial
  stage, record the definition version, journal. Fails if the work item already
  has a run (resume is `status`, never `start`); an explicit `reset` requires
  human confirmation. Every other mutating method also takes `workItem`.
- `record_dispatch {stageId?, mode?, runId?, note?}` — record that the current
  stage's work is being executed (called before the work runs). Increments the
  per-entry dispatch counter, journals a `dispatched` event, and drives the
  runaway-loop guard: the second dispatch of an entry returns a loud
  repeat-dispatch warning, the third is rejected as `runaway-loop-suspected`.
- `record_artifact {name, payload, note?}` — validate against the configured
  schema; auto-capture subject version if `reviews:` is set; bump version.
- `record_evidence {name, payload}` — validated write (declared schema, or the
  built-in outcome schema for a stage's `resultEvidence`).
- `resolve_findings {artifact, resolutions: [{findingId, note}]}` — for
  `kind: findings` artifacts only.
- `approve {gateId, actor, note?}` / `reject {gateId, actor, note}` — human gate
  decisions. Subject-bound gates compute their manifest and digest from trusted
  current run data and refuse missing selections; callers never supply a digest.
  The skill must never call `approve` without explicit human instruction.
- `advance {transition}` — move along a named transition. Gates are evaluated in
  the `gates-satisfied` pre-flight check and re-validated in the method body
  (see checks note below); failure throws with the per-gate reasons. On success:
  write state, journal.
- `status {workItem?}` — read-only: current stage, its `work` spec, the context
  manifest, per-stage cycle counts against limits, and every candidate
  transition with per-gate pass/fail and reasons. Without `workItem`: a
  factory-wide overview of every run. **The driver's entrypoint** — the agent
  asks the factory what is required next instead of knowing the lifecycle.
- `summary {workItem}` — read-only: the full implementation history of a work
  item rendered as markdown, statically from the run data (see "Work-item
  summary report" below).
- `validate {}` — read-only graph lint of the current definition.
- `describe {}` — read-only render: Mermaid of the state machine + gate and
  artifact tables (what humans review before trusting a factory).

**checks**

Check execution receives the method's raw arguments via `unresolvedMethodArgs`
(`method_execution_service.ts` merges raw method args over expression-filtered
global args), so per-transition gating works as a pre-flight check. Caveat baked
into the name: values are pre-CEL-evaluation — gate code must tolerate
unevaluated `${{ }}` strings gracefully (a plain transition name is unaffected).

- `run-started` — every method except `start` requires state.
- `not-terminal` — terminal runs reject all mutating methods.
- `graph-valid` — the definition parses, references resolve, the run's current
  stage exists (this is what makes a mid-run breaking edit loud).
- `valid-transition` — `advance`'s transition (from `unresolvedMethodArgs`)
  exists from the current stage, or is a global transition.
- `gates-satisfied` — evaluate the chosen transition's gates via the gate
  library; fail with the aggregated per-gate reasons.
- `stage-executed` — advancing out of a work-bearing stage by one of its own
  (non-global) transitions requires a `record_dispatch` for the current entry,
  so the work can't be silently skipped. Global escape-hatch transitions are
  exempt.
- `cycle-limits` — see below.

**Defense in depth**: non-required checks are skippable via CLI flags, and only
the _definition_ (not the model type) can mark checks as required
(`checkSelection.require` makes them immune to skip flags). So `advance`
re-validates gates in its method body — the check gives the early,
well-formatted failure; the method body guarantees enforcement even under
`--skip-all-checks`. The shipped examples and the skill's authoring guidance set
`checks: { require: [...] }` on factory definitions as standard practice.

**Graph validation** (at `start`, in `graph-valid`, and via `validate`): exactly
one initial stage; ≥1 terminal; transition targets exist; every non-terminal
stage has ≥1 outgoing transition (counting global ones); gate
`artifact`/`evidence`/`stage` references resolve; `reviews:` links are acyclic;
all artifact schemas compile to zod; **every artifact declares a schema or is
`kind: findings`; every declared evidence declares a schema;
artifact/evidence/`inputsSchema` schemas are `type: object`** (a stage's
`resultEvidence` is exempt — it inherits the built-in outcome schema); every
stage reachable from initial and a terminal reachable from every stage
(warning).

**Cycle semantics**: re-entering a stage increments its cycle counter. Approvals
and evidence are scoped to `(stageId, cycle)` — sending work back and returning
invalidates stale sign-offs automatically. Artifacts persist across cycles
(they're versioned; freshness gates handle staleness).

**Cycle limits are always on.** Every stage has `maxCycles` (default **5**,
overridable per stage, never unlimited-by-omission). Advancing into a stage at
its limit is rejected like any gate failure. The limit is a circuit breaker, not
a dead end: it converts the loop from auto-propelled to human-propelled. A human
grants one additional entry at a time via
`approve {gateId: cycle-override:<stage>}` (scoped to that entry, like any
approval), or takes an escalation/abort transition instead. The trip is
journaled, and `status` always shows per-stage cycle counts against limits.

**Dispatch limits are the within-entry counterpart.** `maxCycles` caps
re-_entries_ (advances back into a stage); it does nothing about a stage that is
re-_dispatched_ within a single entry without ever advancing — the loop that
arises when a stage's work runs but fails to record its product, so `status`
keeps demanding it and the driver keeps re-running. `record_dispatch` records
each execution into the per-entry `dispatches` counter; `maxDispatchesPerCycle`
(default **2**) caps it. Unlike `maxCycles`, tripping it is a **hard fail**
(`runaway-loop-suspected`), not a human-override park: a within-entry
re-dispatch loop is almost always a recording or work-spec defect, so the right
response is to stop and surface diagnostics (missing products, failing gates,
attempt history) rather than grant more attempts. The two limits compose: total
work per stage is bounded by `maxCycles × maxDispatchesPerCycle`, both
deterministic and both recorded.

## Runtime protocol — how a run is driven

The interface stays generic because it is a **fixed protocol, not a
vocabulary**: the verbs never change per factory; only the data they return and
require does. The agent is a generic interpreter, the definition is the program,
the run state is the program counter and memory.

**`status` is the contract.** The agent never knows what any stage means. It
asks the model what is required right now and receives a self-describing packet:
the current stage and cycle, the stage's `work` spec, the context manifest, and
every candidate transition with per-gate pass/fail and human-readable reasons.
The driver loop is the same for every factory:

1. `status` — what stage, what work, which transitions are satisfiable.
2. Execute the `work` block: review the context manifest and pull the relevant
   prior artifacts (see Context discovery under Work modes), load skills, apply
   system prompt + constraints, dispatch via `command` if `mode: dispatch`.
3. `record_artifact` / `record_evidence` the products.
4. Re-check `status`; advance or stop for the human; loop.

**Propulsion vs veto.** The model never moves itself — methods are the only
writes. Gates are _veto_ (hard enforcement: `advance` throws with reasons).
Propulsion comes from the driver, under this policy:

- If exactly one transition is fully satisfied and has no `human-approval` gate,
  the driver advances automatically. Human-approval gates _are_ the configured
  stop-and-ask points — no second mechanism needed.
- `manual: true` on a transition forces a human "go" even when all gates pass.
- If multiple transitions are simultaneously satisfied, the driver asks the
  human. Definition lint warns when sibling transitions have overlapping gate
  conditions — well-formed pass/fail branches are naturally mutually exclusive
  (`findings-clear` failing is what makes the `fail` branch live).

**Equivalent drivers.** Because the protocol is machine-readable, interactive
Claude, an unattended worker (cron/CI agent), and a human driving the `swamp`
CLI by hand are interchangeable. A headless driver runs the identical loop and
parks whenever the only unsatisfied gates are human ones.

**Zero-LLM corridors.** Consecutive `workflow`/`method` stages (test → build →
release) need no LLM at all — the work spec is fully declarative, the outcome
lands as evidence, and outcome-gated pass/fail branches auto-route. A dumb
non-LLM runner can drive those corridors; the agent re-engages only where a
stage requires judgment, or to interpret a failure after the `fail` branch
routes back to an agent stage.

**Starting work is explicit.** The shipped skill is the front door: the user
fires it ("start work on PAY-218"), the skill creates the instance
(`swamp model create @swamp/software-factory <name>`), fills `workItem` and
the stages — from an example, a team template instance (CEL-referenced), or
scratch — has the human confirm the definition, then calls `start`. There are no
implicit defaults: which machine a run executes is always written in its own
definition file.

## The driver skill

One generic `software-factory` skill ships in the extension and is the front
door for all factory work. **Entry flow**: create-and-fill as above (existing
instances are found with `swamp model search`); resuming is `status` on an
existing instance. From there it runs the driver loop.

Skill rules (carried over from issue-lifecycle because they are perfect fits):

- Never satisfy a `human-approval` gate without the human explicitly saying so.
- Persist everything through the model; state must survive sessions.
- On resume, call `status` — never `start` (which fails on an existing run
  anyway).

Authoring gets its own reference: `references/authoring.md` walks through
writing and validating a definition; `references/driving.md` covers the run loop
and the `swamp data query` retrieval recipes.

## Work-item summary report

`summary {workItem}` renders the complete linear history of a run — every stage
visit, artifact version, finding and its resolution, human approval, evidence
record, and transition, including rework loops and resets — as a markdown
document. **No LLM is involved**: pure functions over the recorded run data, so
the same run always renders the same report.

**The journal is the spine, the records are the flesh.** The journal is already
an append-only event log (one version per event: `started`, `artifact_recorded`,
`findings_resolved`, `approved`/`rejected`, `evidence_recorded`, `advanced`,
`reset`, `run_terminal`); replaying it in order _is_ the narrative, with stage
re-entries reading naturally as rework rounds. Each
`artifact_recorded`/`evidence_recorded`/`findings_resolved` event is joined to
the exact record **version** it wrote: journal payloads carry `version` (the
engine stamps it at write time); for runs recorded before that, the k-th write
of a record is version k (ordinal correlation — exact, because versions are
append-only and never deleted, including across resets). Garbage-collected
content degrades gracefully to the journal's own summary line; the report never
fails on partial data.

Rendering is **shape-driven**, never name-driven (payload schemas are user
data): a `findings` array becomes per-finding blocks with status and resolution
notes, a `summary` string leads as a paragraph, description-bearing object
arrays become ordered lists, scalars become key/value lines, anything deeper
falls back to fenced JSON. The markdown is deliberately
terminal-renderer-friendly (swamp renders reports through marked-terminal): no
blockquotes (styled gray-italic and re-wrapped badly), no inline markup inside
list items (emitted literally there), and no wide tables for long prose. One
shared module (`_lib/summary.ts`) feeds both consumers:

- the `summary` method logs the markdown (plus a `SUMMARY_JSON` line with the
  structured timeline) — works with zero configuration;
- the `@swamp/software-factory/work-item-summary` **report** (swamp's report
  extension mechanism, `extensions/reports/`) persists the identical markdown
  and JSON twin as `report-*` data, browsable via `swamp report search` /
  `swamp report get`.

The report is a model-type default (`reports:` on the model), guarded to render
only for the factory's `summary` method on success. Because the platform
persists report results unconditionally — empty ones included — definitions
should scope it with method-scoped `reports.require`
(`{ name: ..., methods: [summary] }`, a sibling of `globalArguments`) so the
stored report stream holds only real histories; the shipped examples and the
skill's authoring guidance make that standard practice, mirroring
`checks: { require: [...] }`.

## Extension points

| Concern            | Mechanism                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source control     | `evidence-recorded` gates over agent-recorded facts (PR URL, merge status). The engine never fetches from a git host — same opacity principle issue-lifecycle landed on, made structural.                                                                           |
| CI / testing infra | `workflow` work mode + outcome evidence with `requireField` matching, plus `cooldown` gates.                                                                                                                                                                        |
| Issue trackers     | `workItem` is an opaque global arg; `method`-mode stages invoke tracker-specific model types (forgejo / github / swamp-club issue models) to fetch context or post status, with `${{ workItem }}` bound into their inputs. The factory engine posts nowhere itself. |
| Review tooling     | `work.skills` + `work.systemPrompt` + `work.command` per stage — "a 'plan-review' config with required skills, the agent command, its system prompt" lives here.                                                                                                    |
| Repo conventions   | `work.constraints` pointing at `agent-constraints/*.md`-style files.                                                                                                                                                                                                |
| Stage reuse        | Platform CEL references to a template instance's `globalArguments.stages`, or definition `inputs` — no extension code.                                                                                                                                              |

## Versioning & upgrades

- The model type uses the platform's CalVer + `upgrades` mechanism as usual;
  `upgradeAttributes` migrates `globalArguments` (i.e., the factory format)
  across type versions — the meta-schema must evolve backward-readably.
- The definition file is git-tracked and carries its own `version`; run state
  records `definitionVersion` at `start` and the journal notes when it changes
  mid-run. Breaking edits (current stage removed) are caught by the
  `graph-valid` check with a clear error.

## Repository layout

```
software-factory/
  manifest.yaml
  README.md
  extensions/models/
    software_factory.ts        # @swamp/software-factory — the one model type
    _lib/
      definition_schema.ts     # zod meta-schema for globalArguments (stages et al.)
      graph.ts                 # reachability / reference validation
      artifact_schema.ts       # declared schema → zod compiler for payloads
      summary.ts               # work-item history loader + timeline + renderer
      gates/                   # one evaluator per gate type + registry
      *_test.ts
  extensions/reports/
    work_item_summary_report.ts  # persists `summary` output via swamp reports
  .claude/skills/software-factory/
    SKILL.md
    references/
      authoring.md
      driving.md
  examples/
    sdlc-classic.yaml          # plan→review→implement→test→release→uat definition
    feature-factory.yaml       # the walkthrough: dual-skill reviews, test workflow, loop-backs
    minimal.yaml               # two stages, one gate — the hello-world
    retry-feedback.yaml        # LLM method with validation-feedback retry
```

The "adversarial review, comprehensive testing, release, UAT" lifecycle from the
original brief ships as `examples/sdlc-classic.yaml` — a proof the engine
expresses it, not a privileged path.

## Open questions / decision log

1. ~~JSON Schema validation dependency~~ — **resolved**: no validator dependency
   at all. Declared artifact schemas (a JSON-Schema-flavored keyword subset,
   enforced by the meta-schema) are compiled to zod at runtime — zod is already
   the platform's validation idiom for resources and globalArguments, and its
   path-bearing errors are the agent-facing UX we want. Envelope validation (the
   generic `artifact` resource spec) and payload validation are both zod.
2. ~~Single document vs composed stage models~~ — **resolved by the collapse**:
   the platform's CEL model references give template/instance reuse natively; no
   extension-level composition mechanism needed.
3. ~~Sandboxed gate expressions~~ — **resolved and spike-confirmed**: the `cel`
   gate type ships in v1. `createCelEnvironment()` evaluates full CEL (macros
   included) over a materialized run-data context; the spike ran a
   findings-clear predicate with `filter`/`size`/`in` correctly. The engine
   pre-fetches run data so evaluation stays synchronous.
4. ~~Verified workflow outcomes~~ — **resolved and spike-confirmed, promoted to
   v1**: `context.queryData` reaches workflow run records. Every run writes
   `report-swamp-workflow-summary-json` (ownerRef = workflow id) with status,
   runId, and per-step results; step outputs carry
   `workflowRunId`/`jobName`/`stepName` provenance tags. The spike's
   `verify_workflow` method located and parsed a real run summary from model
   code
   (`ownerRef == "<id>" && name == "report-swamp-workflow-summary-json"
   && isLatest == true`).
   Caveat: summaries are GC'd (30d / 5 versions), so the gate verifies fresh
   outcomes within the current cycle window — the journal is the durable audit.
5. ~~Unvalidated data at stage boundaries~~ — **resolved**: strong schemas
   end-to-end. Every artifact and every declared evidence carries a schema
   (graph-enforced as a hard error); payloads validate on
   `record_artifact`/`record_evidence`; object payloads are strict by default
   with `additionalProperties: true` the escape hatch; a stage's
   `resultEvidence` is validated against a built-in outcome contract
   (`{status, runId, outputs?}`) so a "succeeded but recorded nothing" workflow
   fails loudly instead of trapping the driver in a silent re-dispatch loop;
   `inputsSchema` validates a `method`/`workflow` stage's resolved inputs and
   surfaces drift as `invalidInputs`; resource envelopes are typed zod.

6. ~~Runaway re-dispatch loop (lab #757)~~ — **resolved**: a deterministic,
   engine-tracked guard. `record_dispatch` records each stage execution into a
   cycle-scoped `dispatches` counter in run state; the `stage-executed` check
   makes a recorded dispatch a precondition for advancing out of a work-bearing
   stage (so work can't be skipped, and execution is always provable); and
   `maxDispatchesPerCycle` (default 2) hard-fails the third dispatch of an entry
   with `runaway-loop-suspected` diagnostics. This is the within-entry
   counterpart to `maxCycles`, and it closes the "workflow succeeded but
   recorded nothing → re-dispatch forever" loop without relying on the agent to
   count.

7. ~~Retry-with-validation-feedback (lab #786)~~ — **resolved**, engine-owned,
   no new subsystem. The engine already detects malformed LLM output at the
   record seam (strong schemas above); it now also **records** each rejection as
   a `validation-<target>` run-data record (write-then-throw) holding the
   rejected value + path-bearing errors, auto-clears it on a clean record, and
   surfaces it in `status`. A retry stage binds the whole record back into its
   model call
   (`feedback: '${{ data.latest(self.name, "validation-<target>") }}'`), and the
   loop is bounded by the dispatch guard (#757) — `maxDispatchesPerCycle` _is_
   the retry budget. The engine never makes the LLM call: it records the failure
   deterministically (so headless drivers work too) and leaves the re-prompt to
   whoever owns the model call. The #786 proposal assumed an engine-level
   `llmRetry` that re-invokes the model; that would break the record-keeper
   non-goal, so we landed the detection/recording half in the engine and left
   re-invocation at the call layer (driver or method-internal structured
   output).

8. ~~CEL evaluation timing~~ — **resolved**: no custom sigil. Bindings are
   platform CEL over the platform data namespace, evaluated by the engine at
   stage execution time via `context.createCelEnvironment()`, reading raw stage
   config through `context.definitionRepository` (the `globalArgs` proxy guards
   unresolved fields, but the platform demonstrably tolerates unresolved
   expressions in saved definitions — they're stripped from validation and
   guarded lazily). One implementation-time verification remains: confirm
   `swamp model evaluate` / definition save does not hard-fail or freeze values
   when a `data.latest(...)` expression references data that doesn't exist yet
   (expected: left unresolved, like unprovided `inputs.*`; if eager evaluation
   proves disruptive, wrap bindings in CEL `has()`/null guards in the shipped
   examples). **Spike-confirmed**: a definition containing
   `${{ data.latest(self.name, "note-main").payload.branch }}` (data not yet
   written) passed `swamp model validate` 5/5 and survived
   `swamp model evaluate` unresolved; after a stage wrote the data, the engine
   read the raw definition via `context.definitionRepository`, registered a
   `data.latest` receiver on `createCelEnvironment()` (backed by pre-fetched
   resources), and evaluated the binding to the correct value —
   platform-identical syntax, no custom evaluator. Checks receiving
   `unresolvedMethodArgs` and the per-field globalArgs proxy behavior were
   confirmed in the same spike (throwaway at `/tmp/factory-spike`).
