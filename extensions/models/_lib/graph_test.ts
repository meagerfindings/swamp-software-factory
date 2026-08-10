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
import type { FactoryArguments } from "./definition_schema.ts";
import { FactoryArgumentsSchema } from "./definition_schema.ts";
import { validateGraph } from "./graph.ts";

function base(): FactoryArguments {
  return FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "work",
        initial: true,
        artifacts: [
          { name: "out", kind: "findings", reviews: "input" },
          {
            name: "input",
            schema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          },
        ],
        evidence: [
          {
            name: "proof",
            schema: { type: "object", properties: { url: { type: "string" } } },
          },
        ],
        transitions: [
          { name: "finish", to: "done" },
        ],
      },
      { id: "done", terminal: true },
    ],
  });
}

function errorsOf(args: FactoryArguments): string[] {
  return validateGraph(args).errors;
}

Deno.test("validateGraph: valid definition has no errors", () => {
  assertEquals(errorsOf(base()), []);
});

Deno.test("validateGraph: duplicate stage ids", () => {
  const args = base();
  args.stages.push({ ...args.stages[1], id: "work" });
  assert(errorsOf(args).some((e) => e.includes("duplicate stage id")));
});

Deno.test("validateGraph: exactly one initial stage", () => {
  const args = base();
  args.stages[0].initial = false;
  assert(
    errorsOf(args).some((e) => e.includes("exactly one stage must declare")),
  );
  args.stages[0].initial = true;
  args.stages[1].initial = true;
  assert(
    errorsOf(args).some((e) => e.includes("exactly one stage must declare")),
  );
});

Deno.test("validateGraph: at least one terminal stage", () => {
  const args = base();
  args.stages[1].terminal = false;
  args.stages[1].transitions = [{ name: "back", to: "work" }];
  assert(
    errorsOf(args).some((e) => e.includes("at least one stage must declare")),
  );
});

Deno.test("validateGraph: stage cannot be initial and terminal", () => {
  const args = base();
  args.stages[0].terminal = true;
  assert(
    errorsOf(args).some((e) =>
      e.includes("cannot be both initial and terminal")
    ),
  );
});

Deno.test("validateGraph: artifact and evidence names are global", () => {
  const args = base();
  args.stages[1] = {
    ...args.stages[1],
    terminal: true,
    artifacts: [{ name: "out" }],
    evidence: [{ name: "proof" }],
  };
  const errors = errorsOf(args);
  assert(errors.some((e) => e.includes("artifact 'out'")));
  assert(errors.some((e) => e.includes("evidence 'proof'")));
});

Deno.test("validateGraph: reviews must resolve and be acyclic", () => {
  const args = base();
  args.stages[0].artifacts![0].reviews = "missing";
  assert(errorsOf(args).some((e) => e.includes("undeclared artifact")));

  const cyclic = base();
  cyclic.stages[0].artifacts![0].reviews = "input";
  cyclic.stages[0].artifacts![1].reviews = "out";
  assert(errorsOf(cyclic).some((e) => e.includes("cyclic reviews chain")));
});

Deno.test("validateGraph: transition targets must exist", () => {
  const args = base();
  args.stages[0].transitions = [{ name: "finish", to: "nowhere" }];
  assert(errorsOf(args).some((e) => e.includes("unknown stage 'nowhere'")));
});

Deno.test("validateGraph: duplicate transition names per stage", () => {
  const args = base();
  args.stages[0].transitions = [
    { name: "finish", to: "done" },
    { name: "finish", to: "done" },
  ];
  assert(errorsOf(args).some((e) => e.includes("duplicate transition")));
});

Deno.test("validateGraph: non-terminal stages need a way out", () => {
  const args = base();
  args.stages[0].transitions = [];
  assert(
    errorsOf(args).some((e) => e.includes("no outgoing transitions")),
  );
  // A global transition counts as a way out.
  args.globalTransitions = [{ name: "abort", to: "done" }];
  assertEquals(errorsOf(args), []);
});

Deno.test("validateGraph: gate references must resolve", () => {
  const args = base();
  args.stages[0].transitions = [
    {
      name: "finish",
      to: "done",
      gates: [
        { type: "artifact-exists", config: { artifact: "ghost" } },
        { type: "evidence-recorded", config: { name: "ghost-proof" } },
        { type: "max-cycles", config: { stage: "ghost-stage", limit: 2 } },
        { type: "cooldown", config: { afterEvidence: "ghost-ev", seconds: 9 } },
      ],
    },
  ];
  const errors = errorsOf(args);
  assert(errors.some((e) => e.includes("undeclared artifact 'ghost'")));
  assert(errors.some((e) => e.includes("undeclared evidence 'ghost-proof'")));
  assert(errors.some((e) => e.includes("unknown stage 'ghost-stage'")));
  assert(errors.some((e) => e.includes("undeclared evidence 'ghost-ev'")));
});

Deno.test("validateGraph: findings-clear requires kind findings", () => {
  const args = base();
  args.stages[0].transitions = [
    {
      name: "finish",
      to: "done",
      gates: [
        {
          type: "findings-clear",
          config: { artifact: "input", blocking: ["high"] },
        },
      ],
    },
  ];
  assert(errorsOf(args).some((e) => e.includes("kind: findings")));
});

Deno.test("validateGraph: artifact-fresh requires a reviews link", () => {
  const args = base();
  args.stages[0].transitions = [
    {
      name: "finish",
      to: "done",
      gates: [
        { type: "artifact-fresh", config: { artifact: "input" } },
      ],
    },
  ];
  assert(errorsOf(args).some((e) => e.includes("reviews: <subject>")));
});

Deno.test("validateGraph: human-approval cannot use the reserved override prefix", () => {
  const args = base();
  args.stages[0].transitions = [
    {
      name: "finish",
      to: "done",
      gates: [
        {
          type: "human-approval",
          config: { id: "cycle-override:work" },
        },
      ],
    },
  ];
  assert(errorsOf(args).some((e) => e.includes("reserved")));
});

Deno.test("validateGraph: unreachable stages are errors", () => {
  const args = base();
  args.stages.push({ id: "island", transitions: [{ name: "x", to: "done" }] });
  assert(errorsOf(args).some((e) => e.includes("unreachable")));
});

Deno.test("validateGraph: every artifact must declare a schema", () => {
  const args = base();
  args.stages[0].artifacts!.push({ name: "loose-out" });
  const errors = errorsOf(args);
  assert(
    errors.some((e) =>
      e.includes("artifact 'loose-out'") && e.includes("has no schema")
    ),
  );
  // The message points the agent at the skill docs to self-correct.
  assert(errors.some((e) => e.includes("references/authoring.md")));
});

Deno.test("validateGraph: kind: findings satisfies the schema requirement", () => {
  const args = base();
  args.stages[0].artifacts!.push({ name: "more-findings", kind: "findings" });
  assertEquals(errorsOf(args), []);
});

Deno.test("validateGraph: every declared evidence must declare a schema", () => {
  const args = base();
  args.stages[0].evidence!.push({ name: "bare-proof" });
  assert(
    errorsOf(args).some((e) =>
      e.includes("evidence 'bare-proof'") && e.includes("has no schema")
    ),
  );
});

Deno.test("validateGraph: resultEvidence is exempt from the schema requirement", () => {
  // A workflow stage's resultEvidence inherits the built-in outcome schema,
  // so it needs no explicit declaration. (Covered structurally by the
  // implicit-resultEvidence test; asserted here as the mandatory-schema rule.)
  const args = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "test",
        initial: true,
        work: {
          mode: "workflow",
          workflow: { name: "@acme/tests" },
          resultEvidence: "test-run",
        },
        transitions: [{ name: "pass", to: "done" }],
      },
      { id: "done", terminal: true },
    ],
  });
  assertEquals(errorsOf(args), []);
});

Deno.test("validateGraph: non-object artifact/evidence schemas are errors", () => {
  const args = base();
  args.stages[0].artifacts![1].schema = { type: "string" };
  args.stages[0].evidence![0].schema = { type: "array" };
  const errors = errorsOf(args);
  assert(
    errors.some((e) =>
      e.includes("artifact 'input'") && e.includes("type: object")
    ),
  );
  assert(
    errors.some((e) =>
      e.includes("evidence 'proof'") && e.includes("type: object")
    ),
  );
});

Deno.test("validateGraph: evidence-recorded resolves implicit resultEvidence", () => {
  const args = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "test",
        initial: true,
        work: {
          mode: "workflow",
          workflow: { name: "@acme/tests" },
          resultEvidence: "test-run",
        },
        transitions: [
          {
            name: "pass",
            to: "done",
            gates: [
              {
                type: "evidence-recorded",
                config: {
                  name: "test-run",
                  requireField: { status: "succeeded" },
                },
              },
            ],
          },
        ],
      },
      { id: "done", terminal: true },
    ],
  });
  assertEquals(errorsOf(args), []);
});

Deno.test("validateGraph: warnings for missing resultEvidence and dead-end reachability", () => {
  const args = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "test",
        initial: true,
        work: { mode: "workflow", workflow: { name: "@acme/tests" } },
        transitions: [{ name: "loop", to: "trap" }],
      },
      { id: "trap", transitions: [{ name: "again", to: "test" }] },
      { id: "done", terminal: true },
    ],
  });
  const { errors, warnings } = validateGraph(args);
  // 'done' is unreachable — that's an error; the loop also can't finish.
  assert(errors.some((e) => e.includes("unreachable")));
  assert(warnings.some((w) => w.includes("resultEvidence")));
});

// ---------------------------------------------------------------------------
// human-approval subject binding
// ---------------------------------------------------------------------------

/** A definition whose approval gate binds to the given subject config. */
function withSubject(subject: Record<string, unknown>): FactoryArguments {
  return FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "work",
        initial: true,
        artifacts: [{
          name: "input",
          schema: { type: "object", properties: { text: { type: "string" } } },
        }],
        evidence: [{
          name: "proof",
          schema: { type: "object", properties: { url: { type: "string" } } },
        }],
        transitions: [{
          name: "finish",
          to: "done",
          gates: [{
            type: "human-approval",
            config: { id: "sign-off", subject },
          }],
        }],
      },
      { id: "done", terminal: true },
    ],
  });
}

Deno.test("validateGraph: a subject naming declared records is valid", () => {
  assertEquals(
    errorsOf(withSubject({ artifacts: ["input"], evidence: ["proof"] })),
    [],
  );
});

Deno.test("validateGraph: a subject cannot reference undeclared records", () => {
  // An unresolvable name would make the gate permanently unsatisfiable (the
  // subject can never complete), so it is a definition error, not a surprise
  // discovered at approve time.
  assert(
    errorsOf(withSubject({ artifacts: ["nope"] })).some((e) =>
      e.includes("subject references undeclared artifact 'nope'")
    ),
  );
  assert(
    errorsOf(withSubject({ evidence: ["nope"] })).some((e) =>
      e.includes("subject references undeclared evidence 'nope'")
    ),
  );
});

Deno.test("validateGraph: a subject cannot list the same record twice", () => {
  assert(
    errorsOf(withSubject({ artifacts: ["input", "input"] })).some((e) =>
      e.includes("lists artifact 'input' more than once")
    ),
  );
  assert(
    errorsOf(withSubject({ evidence: ["proof", "proof"] })).some((e) =>
      e.includes("lists evidence 'proof' more than once")
    ),
  );
});

Deno.test("validateGraph: one approval id cannot mean two subjects from one stage", () => {
  // Sibling branches gating on the same id with different subjects: a single
  // recorded decision cannot bind to both, so the definition must say which.
  const args = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "work",
        initial: true,
        artifacts: [
          {
            name: "input",
            schema: { type: "object", properties: { t: { type: "string" } } },
          },
          {
            name: "other",
            schema: { type: "object", properties: { t: { type: "string" } } },
          },
        ],
        transitions: [
          {
            name: "finish",
            to: "done",
            gates: [{
              type: "human-approval",
              config: { id: "sign-off", subject: { artifacts: ["input"] } },
            }],
          },
          {
            name: "finish-other",
            to: "done",
            gates: [{
              type: "human-approval",
              config: { id: "sign-off", subject: { artifacts: ["other"] } },
            }],
          },
        ],
      },
      { id: "done", terminal: true },
    ],
  });
  assert(
    errorsOf(args).some((e) =>
      e.includes("different subject configurations") &&
      e.includes("finish") && e.includes("finish-other")
    ),
  );
});

Deno.test("validateGraph: bound and unbound uses of one id from a stage also conflict", () => {
  // "No subject" is its own subject shape: mixing it with a bound use of the
  // same id would let an unbound decision be recorded for a bound gate.
  const args = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "work",
        initial: true,
        artifacts: [{
          name: "input",
          schema: { type: "object", properties: { t: { type: "string" } } },
        }],
        transitions: [
          {
            name: "finish",
            to: "done",
            gates: [{
              type: "human-approval",
              config: { id: "sign-off", subject: { artifacts: ["input"] } },
            }],
          },
          {
            name: "escape",
            to: "done",
            gates: [{
              type: "human-approval",
              config: { id: "sign-off" },
            }],
          },
        ],
      },
      { id: "done", terminal: true },
    ],
  });
  assert(
    errorsOf(args).some((e) => e.includes("different subject configurations")),
  );
});

Deno.test("validateGraph: the same subject on sibling branches is fine", () => {
  // The normal shape — one approval gating both the accept and reject edges.
  const args = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "work",
        initial: true,
        artifacts: [{
          name: "input",
          schema: { type: "object", properties: { t: { type: "string" } } },
        }],
        transitions: [
          {
            name: "finish",
            to: "done",
            gates: [{
              type: "human-approval",
              config: { id: "sign-off", subject: { artifacts: ["input"] } },
            }],
          },
          {
            name: "redo",
            to: "done",
            gates: [{
              type: "human-approval",
              // Same subject, different key order — equality is by value.
              config: { id: "sign-off", subject: { artifacts: ["input"] } },
            }],
          },
        ],
      },
      { id: "done", terminal: true },
    ],
  });
  assertEquals(errorsOf(args), []);
});

Deno.test("validateGraph: a global approval gate is checked against every stage", () => {
  // Global transitions are in scope from every non-terminal stage, so a global
  // gate clashing with a stage-local one is caught at the stage that sees both.
  const args = FactoryArgumentsSchema.parse({
    stages: [
      {
        id: "work",
        initial: true,
        artifacts: [{
          name: "input",
          schema: { type: "object", properties: { t: { type: "string" } } },
        }],
        transitions: [{
          name: "finish",
          to: "done",
          gates: [{
            type: "human-approval",
            config: { id: "sign-off", subject: { artifacts: ["input"] } },
          }],
        }],
      },
      { id: "done", terminal: true },
    ],
    globalTransitions: [{
      name: "abort",
      to: "done",
      gates: [{ type: "human-approval", config: { id: "sign-off" } }],
    }],
  });
  assert(
    errorsOf(args).some((e) => e.includes("different subject configurations")),
  );
});
