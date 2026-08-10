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
import type {
  ArtifactEnvelope,
  EvidenceEnvelope,
  JournalEntry,
} from "./run_data.ts";
import type { RunDataReader, RunHistory } from "./summary.ts";
import {
  buildTimeline,
  buildWorkItemSummary,
  fmtDuration,
  loadRunHistory,
  queryRunDataReader,
  renderPayloadMarkdown,
  renderSummaryMarkdown,
  repositoryRunDataReader,
} from "./summary.ts";

const WI = "TEST-1";
const TYPE = "@mgreten/software-factory";
const MODEL_ID = "11111111-2222-3333-4444-555555555555";

// ---------------------------------------------------------------------------
// In-memory versioned store (null entries = garbage-collected versions).
// ---------------------------------------------------------------------------

type Store = Map<string, (Record<string, unknown> | null)[]>;

function makeReader(store: Store): RunDataReader {
  return {
    versionsOf: (name) =>
      Promise.resolve(
        (store.get(name) ?? []).flatMap((v, i) => v === null ? [] : [i + 1]),
      ),
    read: (name, version) => {
      const versions = store.get(name);
      if (versions === undefined || versions.length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        versions[(version ?? versions.length) - 1] ?? null,
      );
    },
  };
}

function getContentFor(store: Store) {
  return (
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
      data === undefined || data === null
        ? null
        : new TextEncoder().encode(JSON.stringify(data)),
    );
  };
}

function at(minute: number, second = 0): string {
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return `2026-06-11T23:${mm}:${ss}.000Z`;
}

function journalEntry(
  event: string,
  stageId: string,
  summary: string,
  payload: Record<string, unknown>,
  iso: string,
): JournalEntry {
  return { event, workItem: WI, stageId, summary, payload, at: iso };
}

/** A complete plan → review (findings + approval) → implement → done run. */
function happyPathHistory(): RunHistory {
  const journal: JournalEntry[] = [
    journalEntry("started", "planning", `Run started for '${WI}'`, {
      workItem: WI,
      stage: "planning",
    }, at(0)),
    journalEntry("artifact_recorded", "planning", "Recorded artifact 'plan'", {
      name: "plan",
    }, at(1)),
    journalEntry("advanced", "review", "Advanced 'submit': planning → review", {
      transition: "submit",
      from: "planning",
      to: "review",
      cycle: 1,
    }, at(2)),
    journalEntry(
      "artifact_recorded",
      "review",
      "Recorded artifact 'plan-review' (reviews plan v1)",
      { name: "plan-review", subjectVersion: 1 },
      at(3),
    ),
    journalEntry(
      "findings_resolved",
      "review",
      "Resolved 1 finding(s) in 'plan-review'",
      {
        artifact: "plan-review",
        resolutions: [{ findingId: "F-1", note: "will quote the expansion" }],
      },
      at(4),
    ),
    journalEntry(
      "approved",
      "review",
      "adam approved 'plan-approval': ship it",
      { gateId: "plan-approval", actor: "adam", note: "ship it" },
      at(5),
    ),
    journalEntry(
      "advanced",
      "implementing",
      "Advanced 'approve': review → implementing",
      { transition: "approve", from: "review", to: "implementing", cycle: 1 },
      at(6),
    ),
    journalEntry(
      "evidence_recorded",
      "implementing",
      "Recorded evidence 'change-request'",
      { name: "change-request" },
      at(7),
    ),
    journalEntry(
      "run_terminal",
      "done",
      "Advanced 'submit': implementing → done (terminal)",
      { transition: "submit", from: "implementing", to: "done", cycle: 1 },
      at(8, 30),
    ),
  ];

  return {
    slug: WI,
    state: {
      workItem: WI,
      stageId: "done",
      cycles: { planning: 1, review: 1, implementing: 1, done: 1 },
      enteredAt: at(8, 30),
      status: "terminal",
      definitionVersion: 3,
      startedAt: at(0),
    },
    journal: journal.map((entry, index) => ({ version: index + 1, entry })),
    journalTruncated: false,
    artifactVersions: new Map<string, Map<number, ArtifactEnvelope>>([
      [
        "plan",
        new Map<number, ArtifactEnvelope>([[1, {
          name: "plan",
          workItem: WI,
          stageId: "planning",
          cycle: 1,
          payload: {
            summary: "build the thing",
            steps: [{ description: "edit the script", files: ["hello.sh"] }],
          },
          recordedAt: at(1),
        }]]),
      ],
      [
        "plan-review",
        new Map<number, ArtifactEnvelope>([
          [1, {
            name: "plan-review",
            workItem: WI,
            stageId: "review",
            cycle: 1,
            payload: {
              summary: "plan is sound",
              findings: [{
                id: "F-1",
                severity: "medium",
                description: "unquoted expansion | risky",
                resolved: false,
              }],
            },
            subjectVersion: 1,
            recordedAt: at(3),
          }],
          [2, {
            name: "plan-review",
            workItem: WI,
            stageId: "review",
            cycle: 1,
            payload: {
              summary: "plan is sound",
              findings: [{
                id: "F-1",
                severity: "medium",
                description: "unquoted expansion | risky",
                resolved: true,
                resolutionNote: "will quote the expansion",
              }],
            },
            subjectVersion: 1,
            recordedAt: at(3),
            resolvedAt: at(4),
          }],
        ]),
      ],
    ]),
    evidenceVersions: new Map<string, Map<number, EvidenceEnvelope>>([
      [
        "change-request",
        new Map<number, EvidenceEnvelope>([[1, {
          name: "change-request",
          workItem: WI,
          stageId: "implementing",
          cycle: 1,
          payload: { status: "succeeded", url: "https://example.com/pr/7" },
          recordedAt: at(7),
        }]]),
      ],
    ]),
  };
}

// ---------------------------------------------------------------------------
// loadRunHistory
// ---------------------------------------------------------------------------

Deno.test("loadRunHistory: journal-driven, all versions, keyed by logical name", async () => {
  const store: Store = new Map([
    ["state-TEST-1", [{
      workItem: WI,
      stageId: "review",
      cycles: { planning: 2, review: 1 },
      enteredAt: at(5),
      status: "active",
      definitionVersion: 1,
      startedAt: at(0),
    }]],
    ["journal-TEST-1", [
      journalEntry(
        "started",
        "planning",
        "Run started",
        { stage: "planning" },
        at(0),
      ),
      journalEntry(
        "artifact_recorded",
        "planning",
        "Recorded artifact 'plan'",
        {
          name: "plan",
        },
        at(1),
      ),
    ]],
    ["artifact-TEST-1-plan", [
      {
        name: "plan",
        workItem: WI,
        stageId: "planning",
        cycle: 1,
        payload: { summary: "v1" },
        recordedAt: at(1),
      },
      {
        name: "plan",
        workItem: WI,
        stageId: "planning",
        cycle: 2,
        payload: { summary: "v2" },
        recordedAt: at(4),
      },
    ]],
    // Another work item on the same instance must not leak in.
    ["artifact-TEST-2-plan", [{
      name: "plan",
      workItem: "TEST-2",
      stageId: "planning",
      cycle: 1,
      payload: { summary: "other" },
      recordedAt: at(1),
    }]],
  ]);

  const history = await loadRunHistory(makeReader(store), WI);
  assertEquals(history.state?.stageId, "review");
  assertEquals(history.journal.length, 2);
  assertEquals(history.journal[0].entry.event, "started");
  assertEquals(history.journalTruncated, false);
  assertEquals([...history.artifactVersions.keys()], ["plan"]);
  assertEquals(history.artifactVersions.get("plan")?.size, 2);
  assertEquals(
    history.artifactVersions.get("plan")?.get(2)?.payload.summary,
    "v2",
  );
});

Deno.test("loadRunHistory: flags a garbage-collected journal head", async () => {
  const store: Store = new Map([
    ["journal-TEST-1", [
      null, // v1 GC'd
      journalEntry("artifact_recorded", "review", "Recorded artifact 'r'", {
        name: "r",
      }, at(3)),
    ]],
  ]);
  const history = await loadRunHistory(makeReader(store), WI);
  assertEquals(history.journalTruncated, true);
  assertEquals(history.journal.length, 1);
});

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

Deno.test("queryRunDataReader: versions via catalog query, content via repo", async () => {
  const store: Store = new Map([
    ["journal-TEST-1", [
      journalEntry("started", "planning", "Run started", {
        stage: "planning",
      }, at(0)),
    ]],
  ]);
  const predicates: string[] = [];
  const reader = queryRunDataReader({
    queryData: (predicate) => {
      predicates.push(predicate);
      // Catalog rows arrive unordered; only `version` is read.
      return Promise.resolve([{ version: 1 }, { notAVersion: true }]);
    },
    dataRepository: { getContent: getContentFor(store) },
    modelType: TYPE,
    modelId: MODEL_ID,
    modelName: "test-factory",
  });

  assertEquals(await reader.versionsOf("journal-TEST-1"), [1]);
  assertEquals(
    predicates[0],
    `modelType == "${TYPE}" && modelName == "test-factory" && name == "journal-TEST-1" && version > 0`,
  );
  const entry = await reader.read("journal-TEST-1", 1);
  assertEquals(entry?.event, "started");
});

Deno.test("repositoryRunDataReader: requires listVersions", async () => {
  const store: Store = new Map();
  const withVersions = repositoryRunDataReader({
    dataRepository: {
      getContent: getContentFor(store),
      listVersions: (_t, _m, name) =>
        Promise.resolve((store.get(name) ?? []).map((_, i) => i + 1)),
    },
    modelType: TYPE,
    modelId: MODEL_ID,
  });
  assertEquals(await withVersions.versionsOf("journal-TEST-1"), []);

  const without = repositoryRunDataReader({
    dataRepository: { getContent: getContentFor(store) },
    modelType: TYPE,
    modelId: MODEL_ID,
  });
  let message = "";
  try {
    await without.versionsOf("journal-TEST-1");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "listVersions");
});

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

Deno.test("buildTimeline: happy path — visits, version correlation, totals", () => {
  const timeline = buildTimeline(happyPathHistory(), WI, {
    factoryName: "test-factory",
    reviews: new Map([["plan-review", "plan"]]),
  });

  assertEquals(timeline.runStatus, "terminal");
  assertEquals(timeline.currentStageId, "done");
  assertEquals(timeline.startedAt, at(0));
  assertEquals(timeline.endedAt, at(8, 30));
  assertEquals(timeline.path, ["planning", "review", "implementing", "done"]);
  assertEquals(timeline.visits.length, 4);

  const [planning, review, implementing, done] = timeline.visits;
  assertEquals(planning.enteredVia, "start");
  assertEquals(planning.exit, {
    transition: "submit",
    to: "review",
    terminal: false,
  });
  assertEquals(planning.leftAt, at(2));

  // Ordinal correlation: plan-review recorded (v1), findings_resolved (v2).
  const reviewArtifact = review.events[0];
  assertEquals(reviewArtifact.kind, "artifact");
  assertEquals(reviewArtifact.artifact?.version, 1);
  assertEquals(reviewArtifact.artifact?.isFindings, true);
  assertEquals(reviewArtifact.artifact?.subjectName, "plan");
  assertEquals(reviewArtifact.artifact?.subjectVersion, 1);

  const resolved = review.events[1];
  assertEquals(resolved.kind, "findings_resolved");
  assertEquals(resolved.resolutions, [{
    findingId: "F-1",
    note: "will quote the expansion",
  }]);

  const approval = review.events[2];
  assertEquals(approval.approval?.decision, "approved");
  assertEquals(approval.approval?.actor, "adam");

  const evidence = implementing.events[0];
  assertEquals(evidence.evidence?.name, "change-request");
  assertEquals(evidence.evidence?.available, true);

  assertEquals(done.terminal, true);
  assertEquals(done.events.length, 0);

  assertEquals(timeline.totals, {
    events: 9,
    stageVisits: 4,
    artifactsRecorded: 2,
    evidenceRecorded: 1,
    findingsTotal: 1,
    findingsResolved: 1,
    approvals: 1,
    rejections: 0,
    resets: 0,
  });
});

Deno.test("buildTimeline: explicit journal versions win over ordinal counting", () => {
  const history = happyPathHistory();
  // Stamp the plan-review recording with an explicit version (new engine).
  const entry = history.journal[3].entry;
  entry.payload = { ...entry.payload, version: 2 };
  // Make v2 the only available version so correlation is observable.
  const timeline = buildTimeline(history, WI);
  const review = timeline.visits[1];
  assertEquals(review.events[0].artifact?.version, 2);
  // Resolution note from v2 visible in the recorded payload.
  const findings = review.events[0].artifact?.payload?.findings as {
    resolved: boolean;
  }[];
  assertEquals(findings[0].resolved, true);
});

Deno.test("buildTimeline: rework loop renders as repeated stage visits", () => {
  const history = happyPathHistory();
  // Splice a rework round between approval and the final advance.
  const rework: JournalEntry[] = [
    journalEntry(
      "advanced",
      "planning",
      "Advanced 'rework': review → planning",
      {
        transition: "rework",
        from: "review",
        to: "planning",
        cycle: 2,
      },
      at(5, 30),
    ),
    journalEntry("artifact_recorded", "planning", "Recorded artifact 'plan'", {
      name: "plan",
    }, at(5, 45)),
  ];
  history.journal.splice(
    6,
    0,
    ...rework.map((entry, i) => ({ version: 100 + i, entry })),
  );

  const timeline = buildTimeline(history, WI);
  assertEquals(timeline.path, [
    "planning",
    "review",
    "planning",
    "implementing",
    "done",
  ]);
  const second = timeline.visits[2];
  assertEquals(second.cycle, 2);
  assertEquals(second.enteredVia, "rework");
  // Second plan recording correlates to version 2.
  assertEquals(second.events[0].artifact?.version, 2);
});

Deno.test("buildTimeline: reset opens a new era", () => {
  const history = happyPathHistory();
  history.journal.push({
    version: 10,
    entry: journalEntry("reset", "planning", "Run reset", {
      previousStage: "done",
    }, at(9)),
  });
  const timeline = buildTimeline(history, WI);
  const last = timeline.visits[timeline.visits.length - 1];
  assertEquals(last.eraStart, true);
  assertEquals(last.enteredVia, "reset");
  assertEquals(timeline.totals.resets, 1);
});

Deno.test("buildTimeline: truncated journal synthesizes an opening visit", () => {
  const history = happyPathHistory();
  history.journal = history.journal.slice(3); // drop started/plan/advance
  history.journalTruncated = true;
  const timeline = buildTimeline(history, WI);
  assertEquals(timeline.visits[0].stageId, "review");
  assertEquals(timeline.visits[0].enteredVia, "(unknown)");
  assertEquals(timeline.journalTruncated, true);
});

Deno.test("buildTimeline: unknown events are kept as notes", () => {
  const history = happyPathHistory();
  history.journal.splice(2, 0, {
    version: 99,
    entry: journalEntry(
      "custom_event",
      "planning",
      "Something else happened",
      {},
      at(1, 30),
    ),
  });
  const timeline = buildTimeline(history, WI);
  const note = timeline.visits[0].events[1];
  assertEquals(note.kind, "note");
  assertEquals(note.summary, "Something else happened");
});

// ---------------------------------------------------------------------------
// renderPayloadMarkdown
// ---------------------------------------------------------------------------

Deno.test("renderPayloadMarkdown: findings render as per-finding blocks", () => {
  const md = renderPayloadMarkdown({
    summary: "plan is sound",
    findings: [
      {
        id: "F-1",
        severity: "medium",
        category: "shell",
        description: "unquoted | expansion",
        resolved: true,
        resolutionNote: "quoted now",
      },
      { id: "F-2", severity: "low", description: "naming", resolved: false },
    ],
  });
  assertStringIncludes(md, "plan is sound");
  assert(!md.includes("> plan is sound"), "summaries must not be blockquotes");
  assertStringIncludes(md, "**F-1** (medium, shell) — ✔ quoted now");
  assertStringIncludes(md, "unquoted | expansion");
  assertStringIncludes(md, "**F-2** (low) — open");
  assert(!md.includes("| ID |"), "findings must not render as a table");
});

Deno.test("renderPayloadMarkdown: steps list, scalar arrays, nested objects", () => {
  const md = renderPayloadMarkdown({
    summary: "build it",
    steps: [
      { description: "edit the script", files: ["hello.sh"] },
      { description: "run shellcheck" },
    ],
    files: ["hello.sh", "README.md"],
    attempts: 2,
    config: { nested: { deep: true } },
  });
  assertStringIncludes(md, "1. edit the script — files: hello.sh");
  assertStringIncludes(md, "2. run shellcheck");
  assertStringIncludes(md, "**files:** `hello.sh`, `README.md`");
  assertStringIncludes(md, "**attempts:** 2");
  assertStringIncludes(md, "```json");
});

Deno.test("renderPayloadMarkdown: uniform object arrays become tables", () => {
  const md = renderPayloadMarkdown({
    checks: [
      { name: "lint", status: "ok" },
      { name: "test", status: "ok" },
    ],
  });
  assertStringIncludes(md, "| name | status |");
  assertStringIncludes(md, "| lint | ok |");
});

// ---------------------------------------------------------------------------
// renderSummaryMarkdown
// ---------------------------------------------------------------------------

Deno.test("renderSummaryMarkdown: full report for a terminal run", () => {
  const timeline = buildTimeline(happyPathHistory(), WI, {
    factoryName: "test-factory",
    reviews: new Map([["plan-review", "plan"]]),
  });
  const md = renderSummaryMarkdown(timeline);

  assertStringIncludes(md, "# Work Item: TEST-1");
  assertStringIncludes(md, "**Factory:** test-factory · **Definition:** v3");
  assertStringIncludes(md, "**Started:** 2026-06-11 23:00:00 UTC");
  assertStringIncludes(md, "**Completed:** 2026-06-11 23:08:30 UTC (8m 30s)");
  assertStringIncludes(md, "**Outcome:** 🏁 terminal at `done`");
  assertStringIncludes(md, "**Path:** planning → review → implementing → done");
  assertStringIncludes(md, "9 events · 4 stage visits · 2 artifacts recorded");
  assertStringIncludes(md, "1 findings (1 resolved)");

  assertStringIncludes(md, "## 1. planning (cycle 1) — 2m 0s");
  assertStringIncludes(md, "### 📄 Artifact: plan (v1)");
  assertStringIncludes(md, "build the thing");
  assertStringIncludes(md, "**→ submit** to *review*");

  assertStringIncludes(md, "### 🔍 Review: plan-review (v1, reviews plan v1)");
  assertStringIncludes(md, "### 🛠 Findings resolved in plan-review");
  assertStringIncludes(md, "- F-1 — will quote the expansion");
  assertStringIncludes(
    md,
    "### ✅ Approval: plan-approval — **approved** by adam",
  );
  assertStringIncludes(md, "“ship it”");

  assertStringIncludes(md, "### 🧪 Evidence: change-request");
  assertStringIncludes(md, "**status:** `succeeded`");
  assertStringIncludes(md, "**→ submit** to *done* (terminal)");
  assertStringIncludes(md, "## 4. done (cycle 1)");
  assertStringIncludes(md, "Run reached this terminal stage at");
});

Deno.test("renderSummaryMarkdown: in-flight run shows current position", () => {
  const history = happyPathHistory();
  history.journal = history.journal.slice(0, 4); // stop mid-review
  assert(history.state !== null);
  history.state = {
    ...history.state,
    stageId: "review",
    status: "active",
  };
  const timeline = buildTimeline(history, WI);
  const md = renderSummaryMarkdown(timeline);
  assertStringIncludes(md, "**Currently:** active at `review` (cycle 1)");
  assert(!md.includes("**Outcome:**"));
});

Deno.test("renderSummaryMarkdown: GC'd content falls back to the journal line", () => {
  const history = happyPathHistory();
  history.artifactVersions.get("plan")?.delete(1);
  const timeline = buildTimeline(history, WI);
  const md = renderSummaryMarkdown(timeline);
  assertStringIncludes(md, "_Content no longer available (garbage-collected)");
  assertStringIncludes(md, "Recorded artifact 'plan'_");
});

Deno.test("renderSummaryMarkdown: reset renders an era boundary", () => {
  const history = happyPathHistory();
  history.journal.push({
    version: 10,
    entry: journalEntry("reset", "planning", "Run reset", {}, at(9)),
  });
  const md = renderSummaryMarkdown(buildTimeline(history, WI));
  assertStringIncludes(md, "history continues in a new era");
});

// ---------------------------------------------------------------------------
// buildWorkItemSummary + fmtDuration
// ---------------------------------------------------------------------------

Deno.test("buildWorkItemSummary: end-to-end from a raw store", async () => {
  const store: Store = new Map([
    ["journal-TEST-1", [
      journalEntry(
        "started",
        "planning",
        "Run started",
        { stage: "planning" },
        at(0),
      ),
      journalEntry(
        "artifact_recorded",
        "planning",
        "Recorded artifact 'plan'",
        {
          name: "plan",
        },
        at(1),
      ),
    ]],
    ["artifact-TEST-1-plan", [{
      name: "plan",
      workItem: WI,
      stageId: "planning",
      cycle: 1,
      payload: { summary: "from the store" },
      recordedAt: at(1),
    }]],
  ]);
  const { markdown, timeline } = await buildWorkItemSummary(
    makeReader(store),
    WI,
    WI,
  );
  assertEquals(timeline.visits.length, 1);
  assertStringIncludes(markdown, "from the store");
});

Deno.test("fmtDuration: scales units", () => {
  assertEquals(fmtDuration(31_000), "31s");
  assertEquals(fmtDuration(511_000), "8m 31s");
  assertEquals(fmtDuration(7_320_000), "2h 2m");
});
