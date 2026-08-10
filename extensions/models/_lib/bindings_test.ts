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

import { assert, assertEquals } from "@std/assert";
import { Environment } from "cel-js";
import type { RunView } from "./run_data.ts";
import {
  prepareBindingEnvironment,
  resolveBindings,
  RunDataReceiver,
} from "./bindings.ts";

function viewWith(): RunView {
  return {
    state: null,
    artifacts: new Map([[
      "plan",
      {
        latest: {
          name: "plan",
          workItem: "PAY-218",
          stageId: "planning",
          cycle: 1,
          payload: { summary: "central focus manager" },
          recordedAt: "2026-06-11T10:00:00.000Z",
        },
        version: 2,
      },
    ]]),
    evidence: new Map([[
      "change-request",
      {
        latest: {
          name: "change-request",
          workItem: "PAY-218",
          stageId: "implementing",
          cycle: 1,
          payload: { headSha: "abc123", url: "https://git/pr/1" },
          recordedAt: "2026-06-11T10:30:00.000Z",
        },
        version: 1,
      },
    ]]),
    validations: new Map(),
    approvals: new Map(),
    approvalHistory: new Map(),
    approvalHistoryIssues: new Map(),
  };
}

Deno.test("RunDataReceiver: resolves own artifacts and evidence, rejects others", () => {
  const receiver = new RunDataReceiver("run-1", viewWith());
  const plan = receiver.latest("run-1", "artifact-plan");
  assertEquals(
    (plan?.payload as { summary: string }).summary,
    "central focus manager",
  );
  assertEquals(plan?.version, 2);
  const ev = receiver.latest("run-1", "evidence-change-request");
  assertEquals((ev?.payload as { headSha: string }).headSha, "abc123");
  assertEquals(receiver.latest("other-model", "artifact-plan"), null);
  assertEquals(receiver.latest("run-1", "artifact-missing"), null);
  assertEquals(receiver.latest("run-1", "state-main"), null);
});

Deno.test("prepareBindingEnvironment: platform-identical data.latest syntax", () => {
  const env = new Environment({ unlistedVariablesAreDyn: true });
  const context = prepareBindingEnvironment(
    env,
    "run-1",
    { workItem: "PAY-218" },
    viewWith(),
  );
  assertEquals(
    env.evaluate(
      'data.latest(self.name, "evidence-change-request").payload.headSha',
      context,
    ),
    "abc123",
  );
  assertEquals(
    env.evaluate("self.workItem", context),
    "PAY-218",
  );
});

Deno.test("resolveBindings: whole-string expressions return raw values", () => {
  const { value, unresolved } = resolveBindings(
    {
      inputs: {
        ref:
          '${{ data.latest(self.name, "evidence-change-request").payload.headSha }}',
        count: "${{ 1 + 1 }}",
      },
    },
    makeEvaluator(),
  );
  assertEquals(unresolved, []);
  assertEquals(
    (value.inputs as Record<string, unknown>).ref,
    "abc123",
  );
  assertEquals((value.inputs as Record<string, unknown>).count, 2n);
});

Deno.test("resolveBindings: embedded expressions interpolate as strings", () => {
  const { value, unresolved } = resolveBindings(
    {
      prompt:
        'Review the change at ${{ data.latest(self.name, "evidence-change-request").payload.url }} carefully.',
    },
    makeEvaluator(),
  );
  assertEquals(unresolved, []);
  assertEquals(
    value.prompt,
    "Review the change at https://git/pr/1 carefully.",
  );
});

Deno.test("resolveBindings: failures are reported and the raw text kept", () => {
  const { value, unresolved } = resolveBindings(
    { ref: "${{ definitely.not.bound( }}" },
    makeEvaluator(),
  );
  assertEquals(value.ref, "${{ definitely.not.bound( }}");
  assertEquals(unresolved.length, 1);
  assert(unresolved[0].error.length > 0);
});

Deno.test("resolveBindings: walks arrays and leaves non-strings alone", () => {
  const { value } = resolveBindings(
    {
      list: ["${{ 2 * 3 }}", "plain", 7, true, null],
      nested: { deep: '${{ "x" }}' },
    },
    makeEvaluator(),
  );
  assertEquals(value.list, [6n, "plain", 7, true, null]);
  assertEquals((value.nested as Record<string, unknown>).deep, "x");
});

function makeEvaluator(): (expression: string) => unknown {
  const env = new Environment({ unlistedVariablesAreDyn: true });
  const context = prepareBindingEnvironment(
    env,
    "run-1",
    { workItem: "PAY-218" },
    viewWith(),
  );
  return (expression) => env.evaluate(expression, context);
}
