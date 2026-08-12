// Swamp, an Automation Framework Copyright (C) 2026 System Initiative, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "npm:zod@4.3.6";
import type { ApprovalSubject } from "./approval_subject.ts";
import {
  ApprovalSubjectManifestSchema,
  canonicalJson,
  computeApprovalSubjectContract,
  sha256Hex,
} from "./approval_subject.ts";
import type { ApprovalSubjectSpec } from "./definition_schema.ts";
import { authorityChallengeInstance } from "./run_names.ts";

const HexDigest = z.string().regex(/^[0-9a-f]{64}$/);
const Identity = z.strictObject({
  modelType: z.string(),
  modelId: z.string(),
  modelInstanceName: z.string(),
  definitionName: z.string(),
  definitionVersion: z.number().int().positive(),
  definitionHash: HexDigest,
  workItem: z.string(),
  stageId: z.string(),
  cycle: z.number().int().positive(),
  runEra: z.string(),
  gateId: z.string(),
  transition: z.string(),
});

export const AuthorityChallengePacketSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("authority-challenge"),
  authority: z.literal("non-authorizing"),
  binding: z.strictObject({
    mode: z.literal("legacy-subject"),
    oneApprovalReady: z.literal(false),
    opaqueCertification: z.null(),
  }),
  identity: Identity,
  display: z.strictObject({
    manifest: ApprovalSubjectManifestSchema,
    digest: HexDigest,
    algorithm: z.literal("sha-256"),
  }),
  policy: z.strictObject({
    type: z.literal("human-approval"),
    minApprovals: z.number().int().positive(),
    subjectContractVersion: z.string(),
    subjectContractDigest: HexDigest,
  }),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: HexDigest,
});

export const AuthorityChallengeEventSchema = AuthorityChallengePacketSchema
  .extend({
    digest: HexDigest,
    instanceName: z.string(),
  }).strict();

export type AuthorityChallengeEvent = z.infer<
  typeof AuthorityChallengeEventSchema
>;
export type AuthorityChallengePacket = z.infer<
  typeof AuthorityChallengePacketSchema
>;
export type AuthorityChallengeStatus =
  | "open"
  | "expired"
  | "superseded"
  | "subject-changed"
  | "definition-changed"
  | "run-era-changed"
  | "terminal"
  | "decision-unavailable";

export async function mintAuthorityChallengeEvent(input: {
  identity: z.infer<typeof Identity>;
  subject: ApprovalSubject;
  policy: AuthorityChallengePacket["policy"];
  now?: Date;
  ttlMs?: number;
  nonce?: Uint8Array;
}): Promise<AuthorityChallengeEvent> {
  if (input.subject.missing.length > 0) {
    throw new Error("authority challenge subject is incomplete");
  }
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("invalid challenge lifetime");
  }
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(32));
  if (nonce.byteLength !== 32) {
    throw new Error("authority challenge nonce must be exactly 256 bits");
  }
  const packet = AuthorityChallengePacketSchema.parse({
    version: 1,
    kind: "authority-challenge",
    authority: "non-authorizing",
    binding: {
      mode: "legacy-subject",
      oneApprovalReady: false,
      opaqueCertification: null,
    },
    identity: input.identity,
    display: {
      manifest: input.subject.manifest,
      digest: input.subject.digest,
      algorithm: input.subject.algorithm,
    },
    policy: input.policy,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    nonce: [...nonce].map((byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    ),
  });
  const digest = await sha256Hex(canonicalJson(packet));
  return AuthorityChallengeEventSchema.parse({
    ...packet,
    digest,
    instanceName: authorityChallengeInstance(digest),
  });
}

export async function validateAuthorityChallengeEvent(
  event: unknown,
  expected: {
    resourceName: string;
    modelType: string;
    modelId: string;
    modelInstanceName: string;
    definitionName: string;
    definitionVersion: number;
    definitionHash: string;
    workItem: string;
    stageId: string;
    cycle: number;
    runEra: string;
    gateId: string;
    transition: string;
    subject: ApprovalSubjectSpec;
    minApprovals: number;
  },
): Promise<AuthorityChallengeEvent> {
  const parsed = AuthorityChallengeEventSchema.parse(event);
  const { digest: _digest, instanceName: _instanceName, ...packet } = parsed;
  const digest = await sha256Hex(canonicalJson(packet));
  if (digest !== parsed.digest) {
    throw new Error("authority challenge digest does not match packet");
  }
  if (parsed.instanceName !== authorityChallengeInstance(digest)) {
    throw new Error("authority challenge instance name does not match digest");
  }
  if (expected.resourceName !== parsed.instanceName) {
    throw new Error("authority challenge resource name does not match payload");
  }
  const identity = parsed.identity;
  if (
    identity.modelType !== expected.modelType ||
    identity.modelId !== expected.modelId ||
    identity.modelInstanceName !== expected.modelInstanceName ||
    identity.definitionName !== expected.definitionName ||
    identity.definitionVersion !== expected.definitionVersion ||
    identity.definitionHash !== expected.definitionHash ||
    identity.workItem !== expected.workItem ||
    identity.stageId !== expected.stageId ||
    identity.cycle !== expected.cycle ||
    identity.runEra !== expected.runEra ||
    identity.gateId !== expected.gateId ||
    identity.transition !== expected.transition
  ) {
    throw new Error("authority challenge is outside its expected placement");
  }
  const manifest = parsed.display.manifest;
  if (
    manifest.workItem !== parsed.identity.workItem ||
    manifest.gate.id !== parsed.identity.gateId ||
    (manifest.run !== undefined &&
      (manifest.run.stageId !== parsed.identity.stageId ||
        manifest.run.cycle !== parsed.identity.cycle ||
        manifest.run.era !== parsed.identity.runEra)) ||
    (manifest.definition !== undefined &&
      (manifest.definition.name !== parsed.identity.definitionName ||
        manifest.definition.version !== parsed.identity.definitionVersion))
  ) {
    throw new Error(
      "authority challenge embedded subject identity does not match event identity",
    );
  }
  if (
    await sha256Hex(canonicalJson(manifest)) !==
      parsed.display.digest
  ) {
    throw new Error(
      "authority challenge display digest does not match manifest",
    );
  }
  const reconstructedSubject: ApprovalSubjectSpec = {
    artifacts: manifest.records.filter((record) => record.kind === "artifact")
      .map((record) => record.name),
    evidence: manifest.records.filter((record) => record.kind === "evidence")
      .map((record) => record.name),
    includeRun: manifest.run !== undefined,
    includeDefinition: manifest.definition !== undefined,
  };
  const embeddedContract = await computeApprovalSubjectContract({
    gateId: parsed.identity.gateId,
    transition: parsed.identity.transition,
    subject: reconstructedSubject,
  });
  const trustedContract = await computeApprovalSubjectContract({
    gateId: expected.gateId,
    transition: expected.transition,
    subject: expected.subject,
  });
  if (
    parsed.policy.subjectContractVersion !== embeddedContract.version ||
    parsed.policy.subjectContractDigest !== embeddedContract.digest ||
    parsed.policy.subjectContractVersion !== trustedContract.version ||
    parsed.policy.subjectContractDigest !== trustedContract.digest
  ) {
    throw new Error("authority challenge subject selector contract is invalid");
  }
  if (
    !Number.isSafeInteger(expected.minApprovals) ||
    expected.minApprovals <= 0 ||
    parsed.policy.minApprovals !== expected.minApprovals
  ) {
    throw new Error("authority challenge minimum approvals policy is invalid");
  }
  return parsed;
}

/** Pure, informational classification. It never authorizes or consumes anything. */
export function classifyAuthorityChallenge(input: {
  event: AuthorityChallengeEvent;
  now: Date;
  current?: {
    definitionName: string;
    definitionVersion: number;
    definitionHash: string;
    runEra: string;
    stageId: string;
    cycle: number;
    terminal: boolean;
    subjectDigest?: string;
    latestChallengeDigest?: string;
    decisionAvailable: boolean;
  };
}): AuthorityChallengeStatus {
  const { event, current } = input;
  if (current === undefined || !current.decisionAvailable) {
    return "decision-unavailable";
  }
  if (current.terminal) return "terminal";
  if (current.runEra !== event.identity.runEra) return "run-era-changed";
  if (
    current.definitionName !== event.identity.definitionName ||
    current.definitionVersion !== event.identity.definitionVersion ||
    current.definitionHash !== event.identity.definitionHash
  ) return "definition-changed";
  if (
    current.stageId !== event.identity.stageId ||
    current.cycle !== event.identity.cycle ||
    current.subjectDigest !== event.display.digest
  ) return "subject-changed";
  if (
    current.latestChallengeDigest !== undefined &&
    current.latestChallengeDigest !== event.digest
  ) {
    return "superseded";
  }
  if (input.now.getTime() >= Date.parse(event.expiresAt)) return "expired";
  return "open";
}
