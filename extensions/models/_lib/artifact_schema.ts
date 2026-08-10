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
import type { ArtifactSpec, DeclaredSchema } from "./definition_schema.ts";
import { SeveritySchema } from "./definition_schema.ts";

// ---------------------------------------------------------------------------
// Declared schema → zod compiler.
//
// Artifact payload schemas are user configuration (a JSON-Schema-flavored
// keyword subset, already shape-validated by the meta-schema). We compile
// them to zod so payload validation uses the same engine — and produces the
// same path-bearing error messages — as everything else in swamp.
// ---------------------------------------------------------------------------

/** Payload shape required of `kind: findings` artifacts. Strict: a finding
 * carries exactly the contract fields — drift (typo'd keys, stray data) is
 * rejected, not silently absorbed. */
export const FindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: SeveritySchema,
  description: z.string().min(1),
  category: z.string().optional(),
  resolved: z.boolean().optional(),
  resolutionNote: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const FindingsPayloadSchema = z.strictObject({
  findings: z.array(FindingSchema),
});

export type FindingsPayload = z.infer<typeof FindingsPayloadSchema>;

/**
 * Built-in payload contract for a stage's `resultEvidence` — the recorded
 * outcome of a `workflow`/`method` stage. Required `status` + `runId` so a
 * "succeeded but recorded nothing" outcome fails loudly at the write instead
 * of leaving the gate quietly unsatisfied and the driver re-dispatching
 * forever. Loose on extra keys: an outcome is an opaque external fact and a
 * driver may attach context (duration, message). Authors who want a stricter
 * outcome declare an explicit evidence entry of the same name with its own
 * schema, which overrides this default.
 */
export const OutcomeEvidenceSchema = z.looseObject({
  status: z.enum(["succeeded", "failed"]),
  runId: z.string().min(1),
  outputs: z.record(z.string(), z.unknown()).optional(),
});

/** Compiled object shape (zod fields) plus whether extra keys are allowed. */
function compileObjectShape(
  decl: DeclaredSchema,
): { shape: Record<string, z.ZodType>; additional: boolean } {
  const required = new Set(decl.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [key, child] of Object.entries(decl.properties ?? {})) {
    const compiled = compileDeclaredSchema(child);
    shape[key] = required.has(key) ? compiled : compiled.optional();
  }
  for (const key of required) {
    if (shape[key] === undefined) {
      // Required key without a declared property: any value accepted,
      // presence enforced.
      shape[key] = z.unknown().refine(
        (v) => v !== undefined,
        "required",
      );
    }
  }
  return { shape, additional: decl.additionalProperties === true };
}

/** Build a zod object from a compiled shape: strict by default, loose when
 * the declaration opts into `additionalProperties: true`. */
function objectFromShape(
  shape: Record<string, z.ZodType>,
  additional: boolean,
): z.ZodType {
  return additional ? z.looseObject(shape) : z.strictObject(shape);
}

/** Compile a declared schema (validated subset) into a zod schema. */
export function compileDeclaredSchema(decl: DeclaredSchema): z.ZodType {
  switch (decl.type) {
    case "string": {
      let s = z.string();
      if (decl.minLength !== undefined) s = s.min(decl.minLength);
      if (decl.maxLength !== undefined) s = s.max(decl.maxLength);
      if (decl.pattern !== undefined) s = s.regex(new RegExp(decl.pattern));
      if (decl.enum !== undefined) {
        const allowed = decl.enum;
        return s.refine(
          (v) => allowed.includes(v),
          `must be one of: ${allowed.join(", ")}`,
        );
      }
      return s;
    }
    case "number":
    case "integer": {
      let n = z.number();
      if (decl.type === "integer") n = n.int();
      if (decl.minimum !== undefined) n = n.min(decl.minimum);
      if (decl.maximum !== undefined) n = n.max(decl.maximum);
      if (decl.enum !== undefined) {
        const allowed = decl.enum;
        return n.refine(
          (v) => allowed.includes(v),
          `must be one of: ${allowed.join(", ")}`,
        );
      }
      return n;
    }
    case "boolean":
      return z.boolean();
    case "array": {
      let a = z.array(
        decl.items !== undefined
          ? compileDeclaredSchema(decl.items)
          : z.unknown(),
      );
      if (decl.minItems !== undefined) a = a.min(decl.minItems);
      if (decl.maxItems !== undefined) a = a.max(decl.maxItems);
      return a;
    }
    case "object": {
      // Strict by default: undeclared keys are rejected. The declaration
      // opts back into open-ended payloads with `additionalProperties: true`.
      const { shape, additional } = compileObjectShape(decl);
      return objectFromShape(shape, additional);
    }
  }
}

/**
 * Compile the full payload validator for an artifact spec: the declared
 * schema (if any) plus the findings contract (if `kind: findings`).
 *
 * A findings artifact that also declares a schema is merged into ONE strict
 * object — intersecting two strict objects with `.and()` would reject every
 * key, since each half forbids the other's fields.
 */
export function compileArtifactSchema(spec: ArtifactSpec): z.ZodType {
  if (spec.kind === "findings") {
    let shape: Record<string, z.ZodType> = {
      findings: z.array(FindingSchema),
    };
    let additional = false;
    if (spec.schema !== undefined) {
      if (spec.schema.type !== "object") {
        throw new Error(
          "a kind: findings artifact's schema must be type: object " +
            "(its payload is an object carrying a findings array)",
        );
      }
      const obj = compileObjectShape(spec.schema);
      // Declared properties first; the findings contract wins on conflict.
      shape = { ...obj.shape, ...shape };
      additional = obj.additional;
    }
    return objectFromShape(shape, additional);
  }
  if (spec.schema !== undefined) return compileDeclaredSchema(spec.schema);
  // No declared constraints. Mandatory-schema is enforced at graph validation,
  // so a valid definition never reaches here; reject all keys defensively
  // rather than silently accepting anything.
  return z.strictObject({});
}

/** Format zod issues as compact, path-bearing reasons. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Validate a payload against an artifact spec. Returns null when valid,
 * otherwise the list of path-bearing validation errors.
 */
export function validateArtifactPayload(
  spec: ArtifactSpec,
  payload: unknown,
): string[] | null {
  const result = compileArtifactSchema(spec).safeParse(payload);
  if (result.success) return null;
  return formatIssues(result.error);
}

/**
 * Validate a payload against a declared schema (evidence payloads, resolved
 * method/workflow inputs). Returns null when valid, else path-bearing errors.
 */
export function validateDeclaredPayload(
  schema: DeclaredSchema,
  payload: unknown,
): string[] | null {
  const result = compileDeclaredSchema(schema).safeParse(payload);
  if (result.success) return null;
  return formatIssues(result.error);
}

/**
 * Validate a `resultEvidence` payload against the built-in outcome contract.
 * Returns null when valid, else path-bearing errors.
 */
export function validateOutcomePayload(payload: unknown): string[] | null {
  const result = OutcomeEvidenceSchema.safeParse(payload);
  if (result.success) return null;
  return formatIssues(result.error);
}
