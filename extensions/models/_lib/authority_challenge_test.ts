// Swamp, an Automation Framework Copyright (C) 2026 System Initiative, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  canonicalJson,
  computeApprovalSubject,
  computeApprovalSubjectContract,
  sha256Hex,
} from "./approval_subject.ts";
import {
  classifyAuthorityChallenge,
  mintAuthorityChallengeEvent,
  validateAuthorityChallengeEvent,
} from "./authority_challenge.ts";
import type { RunState, RunView } from "./run_data.ts";

const now = new Date("2026-08-12T12:00:00.000Z");
const state: RunState = {
  workItem: "WI-1",
  stageId: "review",
  cycles: { review: 2 },
  enteredAt: now.toISOString(),
  status: "active",
  definitionVersion: 3,
  startedAt: "2026-08-12T11:00:00.000Z",
};
const view: RunView = {
  state,
  artifacts: new Map([
    ["plan", {
      version: 7,
      latest: {
        name: "plan",
        workItem: "WI-1",
        stageId: "review",
        cycle: 2,
        payload: { summary: "ship it" },
        recordedAt: "2026-08-12T11:30:00.000Z",
      },
    }],
    ["review", {
      version: 2,
      latest: {
        name: "review",
        workItem: "WI-1",
        stageId: "review",
        cycle: 2,
        payload: { findings: [] },
        recordedAt: "2026-08-12T11:32:00.000Z",
      },
    }],
  ]),
  evidence: new Map([["checks", {
    version: 4,
    latest: {
      name: "checks",
      workItem: "WI-1",
      stageId: "review",
      cycle: 2,
      payload: { passed: true },
      recordedAt: "2026-08-12T11:35:00.000Z",
    },
  }]]),
  validations: new Map(),
  approvals: new Map(),
  approvalHistory: new Map(),
  approvalHistoryIssues: new Map(),
};

const subjectSpec = {
  artifacts: ["plan", "review"],
  evidence: ["checks"],
};

async function event(
  nonce = new Uint8Array(32),
  spec: typeof subjectSpec & {
    includeRun?: boolean;
    includeDefinition?: boolean;
  } = subjectSpec,
) {
  const subject = await computeApprovalSubject({
    gateId: "ship",
    subject: spec,
    workItem: "WI-1",
    state,
    view,
    definition: { name: "factory", version: 3 },
  });
  const contract = await computeApprovalSubjectContract({
    gateId: "ship",
    transition: "approve",
    subject: spec,
  });
  return await mintAuthorityChallengeEvent({
    identity: {
      modelType: "@swamp/software-factory",
      modelId: "model-1",
      modelInstanceName: "factory",
      definitionName: "factory",
      definitionVersion: 3,
      definitionHash: "a".repeat(64),
      workItem: "WI-1",
      stageId: "review",
      cycle: 2,
      runEra: state.startedAt,
      gateId: "ship",
      transition: "approve",
    },
    subject,
    policy: {
      type: "human-approval",
      minApprovals: 1,
      subjectContractVersion: contract.version,
      subjectContractDigest: contract.digest,
    },
    now,
    nonce,
  });
}

function expected(
  challenge: Awaited<ReturnType<typeof event>>,
  spec = subjectSpec,
) {
  return {
    resourceName: challenge.instanceName,
    modelType: "@swamp/software-factory",
    modelId: "model-1",
    modelInstanceName: "factory",
    definitionName: "factory",
    definitionVersion: 3,
    definitionHash: "a".repeat(64),
    workItem: "WI-1",
    stageId: "review",
    cycle: 2,
    runEra: state.startedAt,
    gateId: "ship",
    transition: "approve",
    subject: spec,
    minApprovals: 1,
  };
}

async function reseal(copy: Record<string, unknown>) {
  const display = copy.display as Record<string, unknown>;
  display.digest = await sha256Hex(canonicalJson(display.manifest));
  const { digest: _digest, instanceName: _instanceName, ...packet } = copy;
  const digest = await sha256Hex(canonicalJson(packet));
  copy.digest = digest;
  copy.instanceName = `authority-challenge-${digest}`;
}

Deno.test("authority challenge is strict, content addressed, and explicitly non-authorizing", async () => {
  const challenge = await event();
  assertEquals(challenge.version, 1);
  assertEquals(challenge.authority, "non-authorizing");
  assertEquals(challenge.binding, {
    mode: "legacy-subject",
    oneApprovalReady: false,
    opaqueCertification: null,
  });
  assertEquals(challenge.nonce, "0".repeat(64));
  assertEquals(
    challenge.instanceName,
    `authority-challenge-${challenge.digest}`,
  );
  assertEquals(
    await validateAuthorityChallengeEvent(challenge, expected(challenge)),
    challenge,
  );
});

Deno.test("authority challenge nonce is exactly 256 bits and changes event identity", async () => {
  await assertRejects(() => event(new Uint8Array(31)), Error, "256 bits");
  const first = await event(new Uint8Array(32));
  const second = await event(new Uint8Array(32).fill(1));
  assertNotEquals(first.nonce, second.nonce);
  assertNotEquals(first.digest, second.digest);
});

Deno.test("authority challenge rejects packet, subject, and cross-run replacement", async () => {
  const original = await event();
  for (
    const mutate of [
      (copy: Record<string, unknown>) => {
        (copy.identity as Record<string, unknown>).runEra = "another-run";
      },
      (copy: Record<string, unknown>) => {
        (copy.display as Record<string, unknown>).digest = "c".repeat(64);
      },
      (copy: Record<string, unknown>) => {
        copy.instanceName = `authority-challenge-${"d".repeat(64)}`;
      },
    ]
  ) {
    const copy = structuredClone(original) as Record<string, unknown>;
    mutate(copy);
    await assertRejects(() =>
      validateAuthorityChallengeEvent(copy, expected(original))
    );
  }
});

Deno.test("authority challenge accepts each optional subject identity combination", async () => {
  for (
    const spec of [
      { ...subjectSpec, includeRun: false },
      { ...subjectSpec, includeDefinition: false },
      { ...subjectSpec, includeRun: false, includeDefinition: false },
    ]
  ) {
    const challenge = await event(new Uint8Array(32), spec);
    assertEquals(
      await validateAuthorityChallengeEvent(
        challenge,
        expected(challenge, spec),
      ),
      challenge,
    );
  }
});

Deno.test("authority challenge rejects resealed cross-scope transplants and layered display tampering", async () => {
  const original = await event();
  for (
    const [field, value] of [
      ["modelId", "other-model"],
      ["modelInstanceName", "other-instance"],
      ["workItem", "WI-2"],
      ["transition", "reject"],
    ] as const
  ) {
    const copy = structuredClone(original) as Record<string, unknown>;
    (copy.identity as Record<string, unknown>)[field] = value;
    const manifest = (copy.display as Record<string, unknown>)
      .manifest as Record<
        string,
        unknown
      >;
    if (field === "workItem") manifest.workItem = value;
    await reseal(copy);
    const resealed = copy as Awaited<ReturnType<typeof event>>;
    await assertRejects(() =>
      validateAuthorityChallengeEvent(copy, {
        ...expected(original),
        resourceName: resealed.instanceName,
      })
    );
  }

  for (
    const mutate of [
      (manifest: Record<string, unknown>) => {
        const records = manifest.records as Record<string, unknown>[];
        records[0] = { ...records[0], name: "replacement" };
      },
      (manifest: Record<string, unknown>) => {
        const records = manifest.records as Record<string, unknown>[];
        manifest.records = [...records].reverse();
      },
      (manifest: Record<string, unknown>) => delete manifest.run,
      (manifest: Record<string, unknown>) => delete manifest.definition,
    ]
  ) {
    const displayCopy = structuredClone(original) as Record<string, unknown>;
    const manifest = (displayCopy.display as Record<string, unknown>)
      .manifest as Record<string, unknown>;
    mutate(manifest);
    await reseal(displayCopy);
    await assertRejects(() =>
      validateAuthorityChallengeEvent(displayCopy, {
        ...expected(original),
        resourceName: String(displayCopy.instanceName),
      })
    );
  }

  for (
    const spec of [
      { ...subjectSpec, includeRun: false },
      { ...subjectSpec, includeDefinition: false },
    ]
  ) {
    const withoutIdentity = await event(new Uint8Array(32), spec);
    const copy = structuredClone(withoutIdentity) as Record<string, unknown>;
    const manifest = (copy.display as Record<string, unknown>)
      .manifest as Record<string, unknown>;
    if ("includeRun" in spec && spec.includeRun === false) {
      manifest.run = { stageId: "review", cycle: 2, era: state.startedAt };
    } else {
      manifest.definition = { name: "factory", version: 3 };
    }
    await reseal(copy);
    await assertRejects(() =>
      validateAuthorityChallengeEvent(copy, {
        ...expected(withoutIdentity, spec),
        resourceName: String(copy.instanceName),
      })
    );
  }

  const policyCopy = structuredClone(original) as Record<string, unknown>;
  (policyCopy.policy as Record<string, unknown>).minApprovals = 2;
  await reseal(policyCopy);
  await assertRejects(() =>
    validateAuthorityChallengeEvent(policyCopy, {
      ...expected(original),
      resourceName: String(policyCopy.instanceName),
    })
  );
  await assertRejects(() =>
    validateAuthorityChallengeEvent(original, {
      ...expected(original),
      resourceName: "authority-challenge-wrong",
    })
  );
});

Deno.test("authority challenge canonical status classifies drift without granting authority", async () => {
  const challenge = await event();
  const current = {
    definitionName: "factory",
    definitionVersion: 3,
    definitionHash: "a".repeat(64),
    runEra: state.startedAt,
    stageId: "review",
    cycle: 2,
    terminal: false,
    subjectDigest: challenge.display.digest,
    latestChallengeDigest: challenge.digest,
    decisionAvailable: true,
  };
  assertEquals(
    classifyAuthorityChallenge({ event: challenge, now, current }),
    "open",
  );
  assertEquals(
    classifyAuthorityChallenge({
      event: challenge,
      now: new Date(challenge.expiresAt),
      current,
    }),
    "expired",
  );
  assertEquals(
    classifyAuthorityChallenge({
      event: challenge,
      now,
      current: { ...current, latestChallengeDigest: "f".repeat(64) },
    }),
    "superseded",
  );
  assertEquals(
    classifyAuthorityChallenge({
      event: challenge,
      now,
      current: { ...current, subjectDigest: "f".repeat(64) },
    }),
    "subject-changed",
  );
  assertEquals(
    classifyAuthorityChallenge({
      event: challenge,
      now,
      current: { ...current, definitionVersion: 4 },
    }),
    "definition-changed",
  );
  assertEquals(
    classifyAuthorityChallenge({
      event: challenge,
      now,
      current: { ...current, runEra: "new" },
    }),
    "run-era-changed",
  );
  assertEquals(
    classifyAuthorityChallenge({
      event: challenge,
      now,
      current: { ...current, terminal: true },
    }),
    "terminal",
  );
  assertEquals(
    classifyAuthorityChallenge({
      event: challenge,
      now,
      current: { ...current, decisionAvailable: false },
    }),
    "decision-unavailable",
  );
});
