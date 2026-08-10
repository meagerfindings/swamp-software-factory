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

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  allApprovalGateIds,
  allEvidenceNames,
  celName,
  FactoryArgumentsSchema,
  findArtifactSpec,
  initialStage,
  maxCyclesFor,
  PlatformArgumentsSchema,
  transitionsFrom,
} from "./definition_schema.ts";

function validDefinition(): Record<string, unknown> {
  return {
    stages: [
      {
        id: "build",
        initial: true,
        work: { mode: "interactive", skills: ["implementation"] },
        artifacts: [
          {
            name: "summary",
            schema: {
              type: "object",
              required: ["text"],
              properties: { text: { type: "string" } },
            },
          },
        ],
        evidence: [{ name: "change-request" }],
        transitions: [
          {
            name: "submit",
            to: "done",
            gates: [
              { type: "artifact-exists", config: { artifact: "summary" } },
            ],
          },
        ],
      },
      { id: "done", terminal: true },
    ],
    globalTransitions: [
      {
        name: "abort",
        to: "done",
        gates: [
          { type: "human-approval", config: { id: "abort-confirmation" } },
        ],
      },
    ],
  };
}

Deno.test("FactoryArgumentsSchema: accepts a valid definition", () => {
  const result = FactoryArgumentsSchema.safeParse(validDefinition());
  assert(result.success, JSON.stringify(result.error?.issues));
});

Deno.test("FactoryArgumentsSchema: rejects bad stage names", () => {
  const def = validDefinition();
  (def.stages as { id: string }[])[0].id = "Build Stage!";
  assertFalse(FactoryArgumentsSchema.safeParse(def).success);
});

Deno.test("FactoryArgumentsSchema: rejects unknown gate types", () => {
  const def = validDefinition();
  const stages = def.stages as {
    transitions?: { gates?: unknown[] }[];
  }[];
  stages[0].transitions![0].gates = [
    { type: "vibes-check", config: {} },
  ];
  assertFalse(FactoryArgumentsSchema.safeParse(def).success);
});

Deno.test("FactoryArgumentsSchema: rejects unknown gate config keys", () => {
  const def = validDefinition();
  const stages = def.stages as {
    transitions?: { gates?: unknown[] }[];
  }[];
  stages[0].transitions![0].gates = [
    { type: "artifact-exists", config: { artifact: "summary", bogus: true } },
  ];
  assertFalse(FactoryArgumentsSchema.safeParse(def).success);
});

Deno.test("FactoryArgumentsSchema: cooldown requires exactly one reference", () => {
  const def = validDefinition();
  const stages = def.stages as {
    transitions?: { gates?: unknown[] }[];
  }[];
  stages[0].transitions![0].gates = [
    { type: "cooldown", config: { seconds: 10 } },
  ];
  assertFalse(FactoryArgumentsSchema.safeParse(def).success);
  stages[0].transitions![0].gates = [
    {
      type: "cooldown",
      config: {
        afterEvidence: "change-request",
        afterArtifact: "summary",
        seconds: 10,
      },
    },
  ];
  assertFalse(FactoryArgumentsSchema.safeParse(def).success);
  stages[0].transitions![0].gates = [
    {
      type: "cooldown",
      config: { afterEvidence: "change-request", seconds: 10 },
    },
  ];
  assert(FactoryArgumentsSchema.safeParse(def).success);
});

Deno.test("FactoryArgumentsSchema: workflow mode requires a workflow block", () => {
  const def = validDefinition();
  (def.stages as { work?: unknown }[])[0].work = { mode: "workflow" };
  assertFalse(FactoryArgumentsSchema.safeParse(def).success);
  (def.stages as { work?: unknown }[])[0].work = {
    mode: "workflow",
    workflow: { name: "@acme/tests", inputs: { ref: "main" } },
    resultEvidence: "test-run",
  };
  assert(FactoryArgumentsSchema.safeParse(def).success);
});

Deno.test("FactoryArgumentsSchema: method mode requires a method block", () => {
  const def = validDefinition();
  (def.stages as { work?: unknown }[])[0].work = { mode: "method" };
  assertFalse(FactoryArgumentsSchema.safeParse(def).success);
  (def.stages as { work?: unknown }[])[0].work = {
    mode: "method",
    method: { modelIdOrName: "runner", methodName: "run" },
    resultEvidence: "run-result",
  };
  assert(FactoryArgumentsSchema.safeParse(def).success);
});

Deno.test("PlatformArgumentsSchema: tolerates empty and partial arguments", () => {
  assert(PlatformArgumentsSchema.safeParse({}).success);
  assert(PlatformArgumentsSchema.safeParse({ stages: undefined }).success);
  // stages stripped by the platform when they contain unresolved expressions
  assert(
    PlatformArgumentsSchema.safeParse({ stages: [{ anything: true }] }).success,
  );
});

Deno.test("helpers: initialStage, maxCyclesFor, findArtifactSpec", () => {
  const args = FactoryArgumentsSchema.parse(validDefinition());
  assertEquals(initialStage(args)?.id, "build");
  assertEquals(maxCyclesFor(args.stages[0]), 5);
  assertEquals(
    maxCyclesFor({ ...args.stages[0], maxCycles: 9 }),
    9,
  );
  assertEquals(findArtifactSpec(args, "summary")?.stageId, "build");
  assertEquals(findArtifactSpec(args, "nope"), undefined);
});

Deno.test("helpers: allEvidenceNames includes implicit resultEvidence", () => {
  const def = validDefinition();
  (def.stages as { work?: unknown }[])[0].work = {
    mode: "workflow",
    workflow: { name: "@acme/tests" },
    resultEvidence: "test-run",
  };
  const args = FactoryArgumentsSchema.parse(def);
  const names = allEvidenceNames(args).map((e) => e.name);
  assert(names.includes("change-request"));
  assert(names.includes("test-run"));
});

Deno.test("helpers: transitionsFrom merges global transitions, terminal gets none", () => {
  const args = FactoryArgumentsSchema.parse(validDefinition());
  const build = transitionsFrom(args, args.stages[0]).map((t) => t.name);
  assertEquals(build, ["submit", "abort"]);
  assertEquals(transitionsFrom(args, args.stages[1]), []);
});

Deno.test("helpers: allApprovalGateIds and celName", () => {
  const args = FactoryArgumentsSchema.parse(validDefinition());
  assertEquals([...allApprovalGateIds(args)], ["abort-confirmation"]);
  assertEquals(celName("plan-review"), "plan_review");
  assertEquals(celName("already_snake"), "already_snake");
});
