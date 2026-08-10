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
import { report } from "./work_item_summary_report.ts";

const WI = "TEST-1";
const TYPE = "@swamp/software-factory";
const MODEL_ID = "11111111-2222-3333-4444-555555555555";

function makeRepo(store: Map<string, Record<string, unknown>[]>) {
  return {
    listVersions: (_type: unknown, _modelId: string, dataName: string) =>
      Promise.resolve((store.get(dataName) ?? []).map((_, i) => i + 1)),
    getContent: (
      _type: unknown,
      _modelId: string,
      dataName: string,
      version?: number,
    ) => {
      const versions = store.get(dataName);
      if (versions === undefined || versions.length === 0) {
        return Promise.resolve(null);
      }
      const data = versions[(version ?? versions.length) - 1];
      return Promise.resolve(
        data === undefined
          ? null
          : new TextEncoder().encode(JSON.stringify(data)),
      );
    },
  };
}

function runStore(): Map<string, Record<string, unknown>[]> {
  const at = (m: number) => `2026-06-11T23:0${m}:00.000Z`;
  return new Map<string, Record<string, unknown>[]>([
    ["state-TEST-1", [{
      workItem: WI,
      stageId: "review",
      cycles: { planning: 1, review: 1 },
      enteredAt: at(2),
      status: "active",
      definitionVersion: 3,
      startedAt: at(0),
    }]],
    ["journal-TEST-1", [
      {
        event: "started",
        workItem: WI,
        stageId: "planning",
        summary: "Run started",
        payload: { stage: "planning" },
        at: at(0),
      },
      {
        event: "artifact_recorded",
        workItem: WI,
        stageId: "planning",
        summary: "Recorded artifact 'plan'",
        payload: { name: "plan", version: 1 },
        at: at(1),
      },
      {
        event: "advanced",
        workItem: WI,
        stageId: "review",
        summary: "Advanced 'submit': planning → review",
        payload: {
          transition: "submit",
          from: "planning",
          to: "review",
          cycle: 1,
        },
        at: at(2),
      },
      {
        event: "artifact_recorded",
        workItem: WI,
        stageId: "review",
        summary: "Recorded artifact 'plan-review' (reviews plan v1)",
        payload: { name: "plan-review", subjectVersion: 1, version: 1 },
        at: at(3),
      },
    ]],
    ["artifact-TEST-1-plan", [{
      name: "plan",
      workItem: WI,
      stageId: "planning",
      cycle: 1,
      payload: { summary: "build the thing" },
      recordedAt: at(1),
    }]],
    ["artifact-TEST-1-plan-review", [{
      name: "plan-review",
      workItem: WI,
      stageId: "review",
      cycle: 1,
      payload: {
        summary: "plan is sound",
        findings: [{
          id: "F-1",
          severity: "low",
          description: "nit",
          resolved: false,
        }],
      },
      subjectVersion: 1,
      recordedAt: at(3),
    }]],
  ]);
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    scope: "method",
    modelType: TYPE,
    modelId: MODEL_ID,
    methodName: "summary",
    executionStatus: "succeeded" as const,
    methodArgs: { workItem: WI },
    definition: { name: "test-factory" },
    dataRepository: makeRepo(runStore()),
    definitionRepository: {
      findById: (_type: unknown, _id: string) =>
        Promise.resolve({
          globalArguments: {
            stages: [
              { id: "planning", artifacts: [{ name: "plan" }] },
              {
                id: "review",
                artifacts: [{ name: "plan-review", reviews: "plan" }],
              },
            ],
          },
        }),
    },
    ...overrides,
  };
}

Deno.test("report export has expected shape", () => {
  assertEquals(report.name, "@swamp/software-factory/work-item-summary");
  assertEquals(report.scope, "method");
  assertEquals(typeof report.execute, "function");
  assert(report.labels.includes("software-factory"));
});

Deno.test("report guards: only the factory's summary method renders", async () => {
  for (
    const context of [
      makeContext({ methodName: "status" }),
      makeContext({ modelType: "@swamp/something-else" }),
      makeContext({ methodArgs: {} }),
    ]
  ) {
    const result = await report.execute(context);
    assertEquals(result, { markdown: "", json: {} });
  }
});

Deno.test("report persists the failure reason on failed summary calls", async () => {
  const result = await report.execute(makeContext({
    executionStatus: "failed",
    errorMessage: "No run for work item 'TEST-1'.",
  }));
  assertStringIncludes(
    result.markdown,
    "_Summary failed: No run for work item",
  );
  assertEquals(result.json, {
    workItem: WI,
    error: "No run for work item 'TEST-1'.",
  });
});

Deno.test("report renders the work item history with definition context", async () => {
  const result = await report.execute(makeContext());
  assertStringIncludes(result.markdown, "# Work Item: TEST-1");
  assertStringIncludes(result.markdown, "**Factory:** test-factory");
  assertStringIncludes(result.markdown, "**Currently:** active at `review`");
  assertStringIncludes(result.markdown, "### 📄 Artifact: plan (v1)");
  assertStringIncludes(
    result.markdown,
    "### 🔍 Review: plan-review (v1, reviews plan v1)",
  );
  const json = result.json as { path?: string[]; runStatus?: string };
  assertEquals(json.path, ["planning", "review"]);
  assertEquals(json.runStatus, "active");
});

Deno.test("report renders without a definition repository", async () => {
  const result = await report.execute(
    makeContext({ definitionRepository: undefined }),
  );
  // Subject name falls back to the generic label.
  assertStringIncludes(
    result.markdown,
    "### 🔍 Review: plan-review (v1, reviews subject v1)",
  );
});
