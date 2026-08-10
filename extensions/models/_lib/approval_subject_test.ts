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

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import type { FactoryArguments } from "./definition_schema.ts";
import { FactoryArgumentsSchema } from "./definition_schema.ts";
import type {
  ArtifactEnvelope,
  EvidenceEnvelope,
  RunState,
  RunView,
} from "./run_data.ts";
import {
  APPROVAL_SUBJECT_ALGORITHM,
  APPROVAL_SUBJECT_VERSION,
  approvalGatesInScope,
  canonicalJson,
  computeApprovalSubject,
  computeApprovalSubjectContract,
  describeSubject,
  includeDefinition,
  includeRun,
  resolveSubjectSpec,
  sha256Hex,
} from "./approval_subject.ts";

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

Deno.test("canonicalJson: sorts object keys recursively", () => {
  assertEquals(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assertEquals(
    canonicalJson({ z: { y: 1, x: 2 }, a: 3 }),
    '{"a":3,"z":{"x":2,"y":1}}',
  );
  // Key order in the input must never reach the output.
  assertEquals(
    canonicalJson({ a: 1, b: { d: 4, c: 3 } }),
    canonicalJson({ b: { c: 3, d: 4 }, a: 1 }),
  );
});

Deno.test("canonicalJson: preserves array order — order is data", () => {
  assertEquals(canonicalJson([3, 1, 2]), "[3,1,2]");
  assertNotEquals(canonicalJson([1, 2]), canonicalJson([2, 1]));
  // Objects inside arrays still get sorted keys, without reordering the array.
  assertEquals(
    canonicalJson([{ b: 1, a: 2 }, { d: 3, c: 4 }]),
    '[{"a":2,"b":1},{"c":4,"d":3}]',
  );
});

Deno.test("canonicalJson: preserves string bytes, including unicode and escapes", () => {
  assertEquals(canonicalJson("héllo"), '"héllo"');
  assertEquals(canonicalJson("a\nb"), '"a\\nb"');
  assertEquals(canonicalJson("🙂"), '"🙂"');
  // Distinct strings must never collide after canonicalization.
  assertNotEquals(canonicalJson("a"), canonicalJson("A"));
  assertNotEquals(canonicalJson(" a"), canonicalJson("a"));
});

Deno.test("canonicalJson: handles scalars, null, and nesting", () => {
  assertEquals(canonicalJson(null), "null");
  assertEquals(canonicalJson(true), "true");
  assertEquals(canonicalJson(false), "false");
  assertEquals(canonicalJson(0), "0");
  assertEquals(canonicalJson(-1.5), "-1.5");
  assertEquals(
    canonicalJson({ a: [{ b: null }], c: "" }),
    '{"a":[{"b":null}],"c":""}',
  );
});

Deno.test("canonicalJson: drops undefined properties, rejects unrepresentable values", () => {
  assertEquals(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  // A value we cannot serialize stably must throw rather than be coerced —
  // a digest over a coerced value would silently stop matching on re-read.
  assertThrows(() => canonicalJson(NaN), Error, "non-finite");
  assertThrows(() => canonicalJson({ a: Infinity }), Error, "non-finite");
  assertThrows(() => canonicalJson(() => {}), Error, "function");
  assertThrows(() => canonicalJson({ a: 1n }), Error, "bigint");
});

Deno.test("sha256Hex: known vector, and stable across calls", async () => {
  assertEquals(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(await sha256Hex("subject"), await sha256Hex("subject"));
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARGS: FactoryArguments = FactoryArgumentsSchema.parse({
  stages: [
    {
      id: "planning",
      initial: true,
      artifacts: [{
        name: "plan",
        schema: { type: "object", properties: { summary: { type: "string" } } },
      }],
      transitions: [{ name: "submit", to: "review" }],
    },
    {
      id: "review",
      artifacts: [{ name: "plan-review", kind: "findings", reviews: "plan" }],
      evidence: [{
        name: "test-run",
        schema: { type: "object", properties: { sha: { type: "string" } } },
      }],
      transitions: [
        {
          name: "accept",
          to: "done",
          gates: [{
            type: "human-approval",
            config: {
              id: "ship-approval",
              subject: { artifacts: ["plan"], evidence: ["test-run"] },
            },
          }],
        },
        {
          name: "reject",
          to: "planning",
          gates: [{
            type: "human-approval",
            config: {
              id: "ship-approval",
              subject: { artifacts: ["plan"], evidence: ["test-run"] },
            },
          }],
        },
        {
          name: "escalate",
          to: "done",
          gates: [{
            type: "human-approval",
            config: { id: "escalation" },
          }],
        },
      ],
    },
    { id: "done", terminal: true },
  ],
});

function state(partial?: Partial<RunState>): RunState {
  return {
    workItem: "TEST-1",
    stageId: "review",
    cycles: { planning: 1, review: 1 },
    enteredAt: "2026-06-11T11:00:00.000Z",
    status: "active",
    definitionVersion: 3,
    startedAt: "2026-06-11T10:00:00.000Z",
    ...partial,
  };
}

function artifact(
  envelope: Partial<ArtifactEnvelope> & { name: string },
  version = 1,
): { latest: ArtifactEnvelope; version: number } {
  return {
    latest: {
      workItem: "TEST-1",
      stageId: "planning",
      cycle: 1,
      payload: { summary: "build it" },
      recordedAt: "2026-06-11T10:30:00.000Z",
      ...envelope,
    },
    version,
  };
}

function evidence(
  envelope: Partial<EvidenceEnvelope> & { name: string },
  version = 1,
): { latest: EvidenceEnvelope; version: number } {
  return {
    latest: {
      workItem: "TEST-1",
      stageId: "review",
      cycle: 1,
      payload: { sha: "abc123" },
      recordedAt: "2026-06-11T11:30:00.000Z",
      ...envelope,
    },
    version,
  };
}

function view(opts?: {
  artifacts?: [string, { latest: ArtifactEnvelope; version: number }][];
  evidence?: [string, { latest: EvidenceEnvelope; version: number }][];
}): RunView {
  return {
    state: null,
    artifacts: new Map(opts?.artifacts ?? []),
    evidence: new Map(opts?.evidence ?? []),
    validations: new Map(),
    approvals: new Map(),
    approvalHistory: new Map(),
    approvalHistoryIssues: new Map(),
  };
}

const DEFINITION = { name: "test-factory", version: 3 };

function compute(opts?: {
  subject?: {
    artifacts?: string[];
    evidence?: string[];
    includeRun?: boolean;
    includeDefinition?: boolean;
  };
  state?: Partial<RunState>;
  view?: RunView;
  definition?: { name: string; version: number };
}) {
  return computeApprovalSubject({
    gateId: "ship-approval",
    subject: opts?.subject ?? { artifacts: ["plan"], evidence: ["test-run"] },
    workItem: "TEST-1",
    state: state(opts?.state),
    view: opts?.view ?? view({
      artifacts: [["plan", artifact({ name: "plan" })]],
      evidence: [["test-run", evidence({ name: "test-run" })]],
    }),
    definition: opts?.definition ?? DEFINITION,
  });
}

// ---------------------------------------------------------------------------
// Manifest and digest
// ---------------------------------------------------------------------------

Deno.test("computeApprovalSubject: manifest carries versioned identity for every selected record", async () => {
  const subject = await compute();
  assertEquals(subject.algorithm, APPROVAL_SUBJECT_ALGORITHM);
  assertEquals(subject.manifest.manifestVersion, APPROVAL_SUBJECT_VERSION);
  assertEquals(subject.manifest.gate, { id: "ship-approval" });
  assertEquals(subject.manifest.workItem, "TEST-1");
  assertEquals(subject.missing, []);

  // Run era and definition identity are in by default.
  assertEquals(subject.manifest.run, {
    stageId: "review",
    cycle: 1,
    era: "2026-06-11T10:00:00.000Z",
  });
  assertEquals(subject.manifest.definition, DEFINITION);

  assertEquals(subject.manifest.records.length, 2);
  assertEquals(subject.manifest.records[0], {
    kind: "artifact",
    name: "plan",
    version: 1,
    stageId: "planning",
    cycle: 1,
    recordedAt: "2026-06-11T10:30:00.000Z",
    payloadDigest: await sha256Hex(canonicalJson({ summary: "build it" })),
  });
  assertEquals(subject.manifest.records[1].kind, "evidence");
  assertEquals(subject.manifest.records[1].name, "test-run");

  // The digest is exactly SHA-256 over the canonical manifest — reproducible
  // by anyone holding the manifest, which is what makes it auditable.
  assertEquals(
    subject.digest,
    await sha256Hex(canonicalJson(subject.manifest)),
  );
});

Deno.test("computeApprovalSubject: identical inputs give an identical digest", async () => {
  const a = await compute();
  const b = await compute();
  assertEquals(a.digest, b.digest);
});

Deno.test("computeApprovalSubject: selection order follows the config, not the map", async () => {
  // Same records, inserted into the view in the opposite order: the manifest
  // must be a function of the definition's declared order.
  const forward = await compute({
    view: view({
      artifacts: [["plan", artifact({ name: "plan" })]],
      evidence: [["test-run", evidence({ name: "test-run" })]],
    }),
  });
  const reversedView: RunView = {
    state: null,
    artifacts: new Map([["plan", artifact({ name: "plan" })]]),
    evidence: new Map([["test-run", evidence({ name: "test-run" })]]),
    validations: new Map(),
    approvals: new Map(),
    approvalHistory: new Map(),
    approvalHistoryIssues: new Map(),
  };
  const reverse = await compute({ view: reversedView });
  assertEquals(forward.digest, reverse.digest);
});

Deno.test("computeApprovalSubject: payload content change moves the digest", async () => {
  const before = await compute();
  const after = await compute({
    view: view({
      artifacts: [[
        "plan",
        artifact({
          name: "plan",
          payload: { summary: "build it differently" },
        }),
      ]],
      evidence: [["test-run", evidence({ name: "test-run" })]],
    }),
  });
  assertNotEquals(before.digest, after.digest);
});

Deno.test("computeApprovalSubject: re-recording identical bytes still moves the digest", async () => {
  // The whole point: same payload, new version and recordedAt. The human
  // approved a recording, not a value.
  const before = await compute();
  const after = await compute({
    view: view({
      artifacts: [[
        "plan",
        artifact(
          { name: "plan", recordedAt: "2026-06-11T12:00:00.000Z" },
          2,
        ),
      ]],
      evidence: [["test-run", evidence({ name: "test-run" })]],
    }),
  });
  assertNotEquals(before.digest, after.digest);
  assertEquals(
    before.manifest.records[0].payloadDigest,
    after.manifest.records[0].payloadDigest,
  );
});

Deno.test("computeApprovalSubject: evidence mutation moves the digest independently", async () => {
  const before = await compute();
  const after = await compute({
    view: view({
      artifacts: [["plan", artifact({ name: "plan" })]],
      evidence: [[
        "test-run",
        evidence({ name: "test-run", payload: { sha: "deadbeef" } }, 2),
      ]],
    }),
  });
  assertNotEquals(before.digest, after.digest);
});

Deno.test("computeApprovalSubject: run slot and era are bound unless opted out", async () => {
  const base = await compute();
  assertNotEquals(
    base.digest,
    (await compute({ state: { cycles: { review: 2 } } })).digest,
  );
  assertNotEquals(
    base.digest,
    (await compute({ state: { stageId: "planning" } })).digest,
  );
  // A reset re-stamps startedAt: decisions from the previous era can't carry.
  assertNotEquals(
    base.digest,
    (await compute({ state: { startedAt: "2026-06-12T10:00:00.000Z" } }))
      .digest,
  );

  // includeRun: false drops the whole run block, and then the slot no longer
  // affects the digest.
  const unpinned = await compute({
    subject: {
      artifacts: ["plan"],
      evidence: ["test-run"],
      includeRun: false,
    },
  });
  assertEquals(unpinned.manifest.run, undefined);
  const unpinnedOtherCycle = await compute({
    subject: {
      artifacts: ["plan"],
      evidence: ["test-run"],
      includeRun: false,
    },
    state: { cycles: { review: 7 } },
  });
  assertEquals(unpinned.digest, unpinnedOtherCycle.digest);
});

Deno.test("computeApprovalSubject: definition identity is bound unless opted out", async () => {
  const base = await compute();
  assertNotEquals(
    base.digest,
    (await compute({ definition: { name: "test-factory", version: 4 } }))
      .digest,
  );
  assertNotEquals(
    base.digest,
    (await compute({ definition: { name: "other-factory", version: 3 } }))
      .digest,
  );

  const unpinned = await compute({
    subject: {
      artifacts: ["plan"],
      evidence: ["test-run"],
      includeDefinition: false,
    },
  });
  assertEquals(unpinned.manifest.definition, undefined);
  assertEquals(
    unpinned.digest,
    (await compute({
      subject: {
        artifacts: ["plan"],
        evidence: ["test-run"],
        includeDefinition: false,
      },
      definition: { name: "test-factory", version: 99 },
    })).digest,
  );
});

Deno.test("computeApprovalSubject: unrecorded selections are reported as missing", async () => {
  const subject = await compute({
    view: view({ artifacts: [["plan", artifact({ name: "plan" })]] }),
  });
  assertEquals(subject.missing, [{ kind: "evidence", name: "test-run" }]);
  assertEquals(subject.manifest.records.length, 1);
});

Deno.test("includeRun / includeDefinition default to true", () => {
  assertEquals(includeRun({ artifacts: ["plan"] }), true);
  assertEquals(includeRun({ artifacts: ["plan"], includeRun: false }), false);
  assertEquals(includeDefinition({ artifacts: ["plan"] }), true);
  assertEquals(
    includeDefinition({ artifacts: ["plan"], includeDefinition: false }),
    false,
  );
});

Deno.test("computeApprovalSubjectContract: omitted defaults normalize and meaningful changes differ", async () => {
  const omitted = await computeApprovalSubjectContract({
    gateId: "gate",
    transition: "ship",
    subject: { artifacts: ["plan"] },
  });
  const explicit = await computeApprovalSubjectContract({
    gateId: "gate",
    transition: "ship",
    subject: {
      artifacts: ["plan"],
      evidence: [],
      includeRun: true,
      includeDefinition: true,
    },
  });
  assertEquals(omitted, explicit);
  assertNotEquals(
    omitted.digest,
    (await computeApprovalSubjectContract({
      gateId: "gate",
      transition: "ship",
      subject: { artifacts: ["plan"], includeRun: false },
    })).digest,
  );
  assertNotEquals(
    omitted.digest,
    (await computeApprovalSubjectContract({
      gateId: "gate",
      transition: "hold",
      subject: { artifacts: ["plan"] },
    })).digest,
  );
});

Deno.test("describeSubject: names what the approval covers", () => {
  assertEquals(
    describeSubject({ artifacts: ["plan"], evidence: ["test-run"] }),
    "artifact 'plan', evidence 'test-run'",
  );
  assertEquals(describeSubject({}), "(no records selected)");
});

// ---------------------------------------------------------------------------
// Gate scope resolution
// ---------------------------------------------------------------------------

Deno.test("approvalGatesInScope: finds every transition gating on an id", () => {
  const inScope = approvalGatesInScope(ARGS, "review", "ship-approval");
  assertEquals(inScope.map((g) => g.transition.name), ["accept", "reject"]);
  assertEquals(approvalGatesInScope(ARGS, "planning", "ship-approval"), []);
  assertEquals(approvalGatesInScope(ARGS, "nowhere", "ship-approval"), []);
});

Deno.test("resolveSubjectSpec: identical subjects across branches resolve to one", () => {
  const { spec, ambiguous } = resolveSubjectSpec(
    approvalGatesInScope(ARGS, "review", "ship-approval"),
  );
  assertEquals(ambiguous, []);
  assertEquals(spec, { artifacts: ["plan"], evidence: ["test-run"] });
});

Deno.test("resolveSubjectSpec: an unbound gate resolves to no subject", () => {
  const { spec, ambiguous } = resolveSubjectSpec(
    approvalGatesInScope(ARGS, "review", "escalation"),
  );
  assertEquals(ambiguous, []);
  assertEquals(spec, undefined);
});

Deno.test("resolveSubjectSpec: differing subjects are ambiguous, never guessed", () => {
  const args: FactoryArguments = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "review",
        initial: true,
        artifacts: [
          {
            name: "plan",
            schema: { type: "object", properties: { s: { type: "string" } } },
          },
          {
            name: "design",
            schema: { type: "object", properties: { s: { type: "string" } } },
          },
        ],
        transitions: [
          {
            name: "accept",
            to: "done",
            gates: [{
              type: "human-approval",
              config: { id: "sign-off", subject: { artifacts: ["plan"] } },
            }],
          },
          {
            name: "accept-design",
            to: "done",
            gates: [{
              type: "human-approval",
              config: { id: "sign-off", subject: { artifacts: ["design"] } },
            }],
          },
        ],
      },
      { id: "done", terminal: true },
    ],
  });
  const { spec, ambiguous } = resolveSubjectSpec(
    approvalGatesInScope(args, "review", "sign-off"),
  );
  assertEquals(spec, undefined);
  assertEquals(ambiguous, ["accept", "accept-design"]);
});

Deno.test("resolveSubjectSpec: subject equality ignores key order", () => {
  const args: FactoryArguments = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "review",
        initial: true,
        artifacts: [{
          name: "plan",
          schema: { type: "object", properties: { s: { type: "string" } } },
        }],
        evidence: [{
          name: "run",
          schema: { type: "object", properties: { s: { type: "string" } } },
        }],
        transitions: [
          {
            name: "a",
            to: "done",
            gates: [{
              type: "human-approval",
              config: {
                id: "sign-off",
                subject: { artifacts: ["plan"], evidence: ["run"] },
              },
            }],
          },
          {
            name: "b",
            to: "done",
            gates: [{
              type: "human-approval",
              config: {
                id: "sign-off",
                // Same subject, different key order in the YAML.
                subject: { evidence: ["run"], artifacts: ["plan"] },
              },
            }],
          },
        ],
      },
      { id: "done", terminal: true },
    ],
  });
  const { spec, ambiguous } = resolveSubjectSpec(
    approvalGatesInScope(args, "review", "sign-off"),
  );
  assertEquals(ambiguous, []);
  assert(spec !== undefined);
});
