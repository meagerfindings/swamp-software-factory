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
import { parse } from "@std/yaml";
import { FactoryArgumentsSchema } from "./_lib/definition_schema.ts";
import { validateGraph } from "./_lib/graph.ts";

const EXAMPLES = [
  "minimal.yaml",
  "feature-factory.yaml",
  "sdlc-classic.yaml",
  "retry-feedback.yaml",
];

function loadExample(name: string): unknown {
  const path = new URL(`../../examples/${name}`, import.meta.url);
  return parse(Deno.readTextFileSync(path));
}

for (const example of EXAMPLES) {
  Deno.test(`example ${example}: bundled into the skill, byte-identical`, () => {
    // The skill ships a copy under references/examples/ so the examples
    // travel with the skill bundle (the extension manifest does not list the
    // top-level examples/ in additionalFiles). Guard against drift.
    const root = Deno.readTextFileSync(
      new URL(`../../examples/${example}`, import.meta.url),
    );
    const bundled = Deno.readTextFileSync(
      new URL(
        `../../.claude/skills/software-factory/references/examples/${example}`,
        import.meta.url,
      ),
    );
    assertEquals(
      bundled,
      root,
      `skill copy of ${example} has drifted from examples/${example}; ` +
        `re-copy examples/ into .claude/skills/software-factory/references/examples/`,
    );
  });

  Deno.test(`example ${example}: parses, meta-schema validates, graph is clean`, () => {
    const doc = loadExample(example);
    const parsed = FactoryArgumentsSchema.safeParse(doc);
    assert(
      parsed.success,
      `meta-schema: ${JSON.stringify(parsed.error?.issues, null, 2)}`,
    );
    const { errors } = validateGraph(parsed.data);
    assertEquals(errors, []);
  });
}

Deno.test("example feature-factory.yaml: exercises every design mechanism", () => {
  const args = FactoryArgumentsSchema.parse(
    loadExample("feature-factory.yaml"),
  );

  const gateTypes = new Set<string>();
  const modes = new Set<string>();
  for (const stage of args.stages) {
    if (stage.work !== undefined) modes.add(stage.work.mode);
    for (const t of stage.transitions ?? []) {
      for (const g of t.gates ?? []) gateTypes.add(g.type);
    }
  }
  for (const t of args.globalTransitions ?? []) {
    for (const g of t.gates ?? []) gateTypes.add(g.type);
  }

  // Work modes: agent stages and a zero-LLM workflow stage.
  assert(modes.has("interactive"));
  assert(modes.has("dispatch"));
  assert(modes.has("workflow"));

  // Gates: freshness-forced re-review, findings, human pauses, verified
  // workflow outcomes.
  for (
    const expected of [
      "artifact-exists",
      "artifact-fresh",
      "findings-clear",
      "human-approval",
      "evidence-recorded",
      "workflow-succeeded",
    ]
  ) {
    assert(gateTypes.has(expected), `missing gate type ${expected}`);
  }

  // Both reviews use the same two skills against different subjects.
  const planReview = args.stages.find((s) => s.id === "plan-review");
  const codeReview = args.stages.find((s) => s.id === "code-review");
  assertEquals(planReview?.work?.skills, codeReview?.work?.skills);
  assertEquals(
    planReview?.artifacts?.[0].reviews,
    "plan",
  );
  assertEquals(
    codeReview?.artifacts?.[0].reviews,
    "change-summary",
  );

  // Run-data bindings are written in platform CEL syntax.
  const testing = args.stages.find((s) => s.id === "testing");
  const ref = (testing?.work?.workflow?.inputs as { ref: string }).ref;
  assert(ref.startsWith("${{"));
  assert(ref.includes("data.latest(self.name,"));
});

Deno.test("example retry-feedback.yaml: wires validation feedback into a method input", () => {
  const args = FactoryArgumentsSchema.parse(loadExample("retry-feedback.yaml"));
  const planning = args.stages.find((s) => s.id === "planning");

  // The method binds the validation record of the artifact it produces.
  const inputs = planning?.work?.method?.inputs as { feedback?: string };
  assert(inputs?.feedback !== undefined, "missing feedback input");
  assert(
    inputs.feedback.includes('data.latest(self.name, "validation-plan")'),
    "feedback should bind the whole validation-plan record",
  );
  // Bound whole-record, not a sub-field (which would throw when absent).
  assert(
    !inputs.feedback.includes('validation-plan").'),
    "bind the whole record, not a sub-field",
  );
  // The fed-back target is the schema'd artifact this stage records.
  const plan = planning?.artifacts?.find((a) => a.name === "plan");
  assert(plan?.schema !== undefined, "plan artifact must declare a schema");
});

Deno.test("example sdlc-classic.yaml: covers the original design brief", () => {
  const args = FactoryArgumentsSchema.parse(loadExample("sdlc-classic.yaml"));
  const ids = args.stages.map((s) => s.id);
  for (
    const expected of [
      "plan-review", // adversarial review
      "testing", // comprehensive testing
      "releasing", // release
      "uat", // UAT
    ]
  ) {
    assert(ids.includes(expected), `missing stage ${expected}`);
  }
  // Includes a cel gate and a cooldown gate.
  const gateTypes = new Set(
    args.stages.flatMap((s) =>
      (s.transitions ?? []).flatMap((t) => (t.gates ?? []).map((g) => g.type))
    ),
  );
  assert(gateTypes.has("cel"));
  assert(gateTypes.has("cooldown"));
});
