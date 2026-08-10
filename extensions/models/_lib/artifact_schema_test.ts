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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  compileDeclaredSchema,
  validateArtifactPayload,
} from "./artifact_schema.ts";
import type { DeclaredSchema } from "./definition_schema.ts";

Deno.test("compileDeclaredSchema: string constraints", () => {
  const schema = compileDeclaredSchema({
    type: "string",
    minLength: 2,
    maxLength: 4,
    pattern: "^[a-z]+$",
  });
  assert(schema.safeParse("abc").success);
  assert(!schema.safeParse("a").success);
  assert(!schema.safeParse("abcde").success);
  assert(!schema.safeParse("ABC").success);
  assert(!schema.safeParse(7).success);
});

Deno.test("compileDeclaredSchema: string enum", () => {
  const schema = compileDeclaredSchema({
    type: "string",
    enum: ["red", "green"],
  });
  assert(schema.safeParse("red").success);
  assert(!schema.safeParse("blue").success);
});

Deno.test("compileDeclaredSchema: number and integer bounds", () => {
  const num = compileDeclaredSchema({ type: "number", minimum: 0, maximum: 1 });
  assert(num.safeParse(0.5).success);
  assert(!num.safeParse(2).success);
  const int = compileDeclaredSchema({ type: "integer" });
  assert(int.safeParse(3).success);
  assert(!int.safeParse(3.5).success);
});

Deno.test("compileDeclaredSchema: boolean and arrays", () => {
  assert(compileDeclaredSchema({ type: "boolean" }).safeParse(true).success);
  const arr = compileDeclaredSchema({
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 2,
  });
  assert(arr.safeParse(["a"]).success);
  assert(!arr.safeParse([]).success);
  assert(!arr.safeParse(["a", "b", "c"]).success);
  assert(!arr.safeParse([1]).success);
});

Deno.test("compileDeclaredSchema: nested objects with required keys", () => {
  const decl: DeclaredSchema = {
    type: "object",
    required: ["steps"],
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          required: ["description"],
          properties: {
            description: { type: "string" },
            order: { type: "integer" },
          },
        },
      },
    },
  };
  const schema = compileDeclaredSchema(decl);
  assert(schema.safeParse({ steps: [{ description: "do it" }] }).success);
  assert(!schema.safeParse({}).success);
  assert(!schema.safeParse({ steps: [{ order: 1 }] }).success);
});

Deno.test("compileDeclaredSchema: undeclared keys are rejected (strict)", () => {
  const schema = compileDeclaredSchema({
    type: "object",
    required: ["a"],
    properties: { a: { type: "string" } },
  });
  assert(schema.safeParse({ a: "x" }).success);
  assert(!schema.safeParse({ a: "x", extra: 42 }).success);
});

Deno.test("compileDeclaredSchema: additionalProperties opts back into loose", () => {
  const schema = compileDeclaredSchema({
    type: "object",
    required: ["a"],
    properties: { a: { type: "string" } },
    additionalProperties: true,
  });
  assert(schema.safeParse({ a: "x", extra: 42 }).success);
});

Deno.test("compileDeclaredSchema: required key without declared property", () => {
  const schema = compileDeclaredSchema({
    type: "object",
    required: ["anything"],
  });
  assert(schema.safeParse({ anything: { nested: true } }).success);
  assert(!schema.safeParse({}).success);
});

Deno.test("validateArtifactPayload: no declared schema rejects unknown keys", () => {
  // A schemaless artifact is a graph-validation error; if one slips through
  // (skip-checks), the compiled validator rejects rather than accepts blindly.
  assertEquals(validateArtifactPayload({ name: "free" }, {}), null);
  assert(validateArtifactPayload({ name: "free" }, { x: 1 }) !== null);
});

Deno.test("validateArtifactPayload: findings kind enforces the contract", () => {
  const spec = { name: "review", kind: "findings" as const };
  assertEquals(
    validateArtifactPayload(spec, {
      findings: [
        { id: "F-1", severity: "high", description: "broken" },
      ],
    }),
    null,
  );
  const missing = validateArtifactPayload(spec, { notes: "looks fine" });
  assert(missing !== null);
  assertStringIncludes(missing.join("\n"), "findings");
  const badSeverity = validateArtifactPayload(spec, {
    findings: [{ id: "F-1", severity: "scary", description: "x" }],
  });
  assert(badSeverity !== null);
  assertStringIncludes(badSeverity.join("\n"), "findings.0.severity");
});

Deno.test("validateArtifactPayload: findings kind combines with declared schema", () => {
  const spec = {
    name: "review",
    kind: "findings" as const,
    schema: {
      type: "object",
      required: ["reviewer"],
      properties: { reviewer: { type: "string" } },
    } as DeclaredSchema,
  };
  assertEquals(
    validateArtifactPayload(spec, { findings: [], reviewer: "arch" }),
    null,
  );
  const issues = validateArtifactPayload(spec, { findings: [] });
  assert(issues !== null);
  assertStringIncludes(issues.join("\n"), "reviewer");
});

Deno.test("validateArtifactPayload: errors carry paths", () => {
  const spec = {
    name: "plan",
    schema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    } as DeclaredSchema,
  };
  const issues = validateArtifactPayload(spec, { summary: 42 });
  assert(issues !== null);
  assertStringIncludes(issues[0], "summary:");
});
