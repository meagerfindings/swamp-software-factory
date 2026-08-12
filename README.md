# @mgreten/software-factory

This is Mat Greten's maintained fork of the upstream
[`@swamp/software-factory`](https://github.com/swamp-club/swamp-extensions/tree/7739f4357a6bc9503ab8ac953ae4b0826eb68603/software-factory)
extension originally developed by System Initiative, Inc. The fork begins at
upstream source commit `7739f4357a6bc9503ab8ac953ae4b0826eb68603`; see
[NOTICE.md](NOTICE.md) for attribution and provenance.

The registry package is installed as `@mgreten/software-factory`, but it
intentionally exports the compatibility model type `@swamp/software-factory`
and report `@swamp/software-factory/work-item-summary`. Keeping those runtime
identifiers stable means existing model UUIDs and recorded run data remain
addressable without migration.

A fully generic, model-driven state machine for guiding agents through a
software development lifecycle. The entire machine — stages, transitions, gates,
required artifacts, review skills, agent commands, system prompts — lives in the
model definition's `globalArguments` as **data**. The engine ships no lifecycle
concepts: adversarial review, comprehensive testing, release, and UAT stages are
things a definition expresses, never things the code knows about.

See [DESIGN.md](DESIGN.md) for the full design and its rationale.

## How it works

An instance is a factory; it serves **many work items concurrently**. Create it
once, then run thousands of work items through it — every method takes
`workItem`, and all run data is namespaced per work item:

```bash
swamp model create @swamp/software-factory my-factory
swamp model edit my-factory      # fill globalArguments: stages
                                 # (seed from examples/, see below)
swamp model method run my-factory validate
swamp model method run my-factory start --input workItem=ISSUE-42
```

From there the protocol is fixed, whatever the factory shape:

```bash
swamp model method run my-factory status --input workItem=ISSUE-42
# → writes the queryable record status-ISSUE-42: current stage, work spec
#   (bindings resolved), per-gate transition readiness, context manifest,
#   cycle counts. Read fields with: swamp data query
#   'name == "status-ISSUE-42"' --select 'attributes.transitions' --json
swamp model method run my-factory status
# → writes status-_factory, a factory-wide overview of every run

swamp model method run my-factory record_artifact --input workItem=ISSUE-42 \
  --input name=plan --input payload='{"summary":"…","steps":[…],"testingStrategy":"…"}'

swamp model method run my-factory advance --input workItem=ISSUE-42 --input transition=submit
# blocked transitions fail with actionable per-gate reasons
```

The agent is a generic interpreter: the definition is the program, each work
item's run state is a program counter, and `status` says what is required next.
The shipped `software-factory` skill teaches Claude the drive loop; "start work
on PAY-218 with the feature factory" is enough.

## Examples

| File                                                           | What it shows                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [examples/minimal.yaml](examples/minimal.yaml)                 | Two stages, one gate — the hello-world.                                                                                                                                                           |
| [examples/feature-factory.yaml](examples/feature-factory.yaml) | Plan → dual-skill adversarial plan review → implement → verified test workflow → dual-skill code review → done, with loop-backs, freshness-forced re-review, human approvals, and a global abort. |
| [examples/sdlc-classic.yaml](examples/sdlc-classic.yaml)       | The classic plan / adversarial-review / implement / test / release / UAT lifecycle, including `cooldown` and `cel` gates.                                                                         |
| [examples/retry-feedback.yaml](examples/retry-feedback.yaml)   | An LLM-backed method whose malformed output is recorded as a `validation` record and fed back into its own next attempt, bounded by the dispatch guard.                                           |

## Concepts

- **Stage** — a named state with a `work` spec (how the work gets done):
  `interactive` (the driving agent), `dispatch` (one subagent per listed skill,
  in parallel), `workflow` (a named swamp workflow — zero-LLM), or `method` (a
  single model method call — also how tracker integrations work).
- **Artifact** — a versioned, schema-validated data product. Schemas are a
  declarative JSON-Schema-flavored subset compiled to zod at runtime (strict
  objects by default; `additionalProperties: true` to opt out). Every artifact
  declares a schema or is `kind: findings`. `kind: findings` unlocks the
  findings machinery; `reviews: <artifact>` pins subject versions for freshness
  checking.
- **Evidence** — external facts (PR URL, CI outcome, release link), cycle-scoped
  and **schema-validated on record** (a stage's `resultEvidence` validates
  against a built-in `{status, runId}` outcome contract). Opaque to gates, but
  never unvalidated. The engine never talks to external systems.
- **Gate** — hard enforcement on transitions: `artifact-exists`,
  `artifact-fresh`, `findings-clear`, `human-approval`, `evidence-recorded`,
  `cooldown`, `max-cycles`, `cel` (CEL predicates over run data), and
  `workflow-succeeded` (verified against swamp's own workflow run records, not
  driver attestation). A `human-approval` gate may declare a `subject` selecting
  artifact and evidence names. Decisions then bind to the exact current record
  versions and canonical payload digests; re-recording any selected item
  invalidates the decision, even in the same stage cycle.
- **Cycles** — re-entering a stage increments its cycle; approvals and evidence
  are cycle-scoped, so rework automatically invalidates stale sign-offs and
  stale test runs. Every stage has `maxCycles` (default 5); entries past the
  limit park the run for an explicit human `cycle-override` approval.
- **Bindings** — stage config references run data in platform CEL syntax:
  `${{ data.latest(self.name, "evidence-change-request").payload.headSha }}`,
  resolved by the engine at stage execution time.

## Methods

| Method               | Purpose                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`              | Validate the graph, start a work item at the initial stage. Refuses to restart — resume with `status`.                                                                                    |
| `status`             | The driver's entrypoint: what a work item requires right now; without `workItem`, an overview of all runs (read-only).                                                                    |
| `record_dispatch`    | Record that the current stage's work is running (before it runs); proves the stage executed and drives the runaway-loop guard.                                                            |
| `record_artifact`    | Record a declared artifact; payload validated against its schema.                                                                                                                         |
| `record_evidence`    | Record a declared external fact; payload validated against its schema (or the built-in outcome schema for `resultEvidence`).                                                              |
| `resolve_findings`   | Resolution notes on `kind: findings` artifacts (not a fresh recording).                                                                                                                   |
| `mint_authority_challenge` | Mint an immutable engine-bound challenge for the current exact approval subject. The first increment is explicitly legacy-subject and **non-authorizing**: it is only a prerequisite record and never approves, dispatches, or advances. |
| `approve` / `reject` | Human gate decisions, cycle-scoped. Subject-bound gates record an `approval-subject-v1` manifest and SHA-256 digest computed from trusted run data. Also grants `cycle-override:<stage>`. |
| `advance`            | Move along a named transition. Gates run in pre-flight checks and re-validate in the method body.                                                                                         |
| `summary`            | The full implementation history of a work item — every stage visit, artifact version, finding, approval, and transition — rendered as markdown, statically from the run data (read-only). |
| `validate`           | Definition lint (read-only).                                                                                                                                                              |
| `describe`           | Mermaid + stage/transition tables (read-only).                                                                                                                                            |
| `reset`              | Destructive restart; requires `confirm=reset`.                                                                                                                                            |

## Run data

All resources are versioned, immutable, and namespaced per work item:
`state-<workItem>`, `artifact-<workItem>-<name>`, `evidence-<workItem>-<name>`,
`approval-<workItem>-<gateId>`, `validation-<workItem>-<target>` (recorded
payload-validation failures, bindable as retry feedback), content-addressed
`authority-challenge-<eventDigest>` non-authorizing prerequisite events, and the append-only
`journal-<workItem>` audit trail. (Work item refs that aren't name-safe — URLs,
say — get a deterministic hashed slug; envelopes always carry the original.)
Inspect with:

```bash
# what exists
swamp data query 'modelName == "my-factory"' --select name
# one payload field, straight from the artifact's declared schema
swamp data query 'modelName == "my-factory" && name == "artifact-ISSUE-42-plan"' --select attributes.payload.summary --json
# the journal (one event per version; referencing `version` opens history)
swamp data query 'modelName == "my-factory" && name == "journal-ISSUE-42" && version > 0' --select attributes.summary --json
```

Records store the envelope as their content, so `attributes.payload.<field>`
reaches the declared schema and `attributes.stageId` / `.cycle` /
`.subjectVersion` reach provenance. The skill's `references/driving.md`
("Querying run data") has the full recipe set.

### Binding approvals to exact subjects

Approval binding is optional, so existing definitions retain their original
cycle-scoped behavior. To make a human decision attest to exact recorded work,
select the records in the gate:

```yaml
- type: human-approval
  config:
    id: plan-approval
    subject:
      artifacts: [plan, plan-review]
      evidence: [change-request]
      # includeRun and includeDefinition default to true
```

`status.approvalGates` exposes whether each gate is bound, its current digest
and manifest, missing selected records, and stale decisions. Each bound gate's
`presentations` array is the actionable review source, with one entry per
transition (each entry starts with `transition`): it includes the full current
manifest and subject-contract digest, selects the prior approval by highest
immutable approval resource version within the exact transition/run era/contract
scope, and loads every prior payload by its exact recorded resource version. It
classifies first, identical, identical-payload re-record, changed, unavailable
legacy/history, and malformed-history cases and emits an untruncated
deterministic JSON-pointer diff. Drivers should present this value instead of
hand-diffing payloads or substituting latest-by-name data. `approve` and
`reject` refuse an incomplete subject and compute the digest themselves. Bound
gates fail closed against legacy unbound records; unbound gates continue to
accept legacy decisions. Rejections block only the exact matching digest.

### Recovery approval notes

Engine-owned `cycle-override:<stage>` and `dispatch-override:<stage>` approvals
expand runtime safety budgets, so their approval notes use this strict form:

```text
gateId=<exact override gate id>; failureSignature=<nonblank correlation value>
```

Notes are limited to 1024 characters. Missing, generic, malformed, duplicate, or
unknown fields are rejected before any run-data write; accepted notes are stored
verbatim. `failureSignature` is an audit correlation value. The generic factory
verifies that it is present but cannot validate it against product-specific
evidence; a product-specific contract must provide that meaning.

## The work-item summary report

`summary` prints a linear markdown history of a work item's run — the back and
forth of plans, reviews, findings and their resolutions, approvals, evidence,
and rework loops — reconstructed entirely from the journal and the versioned run
records. No LLM is involved; the same data always renders the same report.

The extension also ships a `@swamp/software-factory/work-item-summary` report
that persists the identical markdown (plus a structured JSON twin) through
swamp's report machinery, browsable with `swamp report search` /
`swamp report get`. It is a model-type default; to keep the stored report stream
free of empty placeholder versions from other methods, scope it in your
definition file (a sibling of `globalArguments`):

```yaml
reports:
  require:
    - {
        name: "@swamp/software-factory/work-item-summary",
        methods: [summary],
      }
```

## Development

```bash
cd software-factory
deno task check
deno task lint
deno task fmt:check
deno task test
```

## License

GNU Affero General Public License v3 or later (AGPL-3.0-or-later), with the
upstream Swamp Extension and Definition Exception preserved. See the exact
archive-compatible [COPYING.txt](COPYING.txt) and
[COPYING-EXCEPTION.txt](COPYING-EXCEPTION.txt) texts, the preserved
[LICENSE.txt](LICENSE.txt) notice, and [NOTICE.md](NOTICE.md) for attribution
and provenance. The root extensionless `COPYING` and `COPYING-EXCEPTION` files
are exact upstream provenance copies; due to Swamp Lab issue #1564, the
registry archive carries byte-identical `.txt` forms instead.
