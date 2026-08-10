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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { DataRepositoryLike } from "./run_data.ts";
import {
  currentCycle,
  entriesInto,
  loadAllRunStates,
  loadRunView,
  workItemSlug,
} from "./run_data.ts";

/** Versioned in-memory store mimicking swamp's data repository. */
export function memoryRepository(
  initial?: Record<string, Record<string, unknown>[]>,
): DataRepositoryLike & {
  store: Map<string, Record<string, unknown>[]>;
} {
  const store = new Map<string, Record<string, unknown>[]>(
    Object.entries(initial ?? {}),
  );
  return {
    store,
    findAllForModel: (_type, _modelId) => {
      const out: { name: string; version: number }[] = [];
      for (const [name, versions] of store) {
        if (versions.length > 0) out.push({ name, version: versions.length });
      }
      return Promise.resolve(out);
    },
    getContent: (_type, _modelId, dataName, version) => {
      const versions = store.get(dataName);
      if (versions === undefined || versions.length === 0) {
        return Promise.resolve(null);
      }
      const v = version ?? versions.length;
      const data = versions[v - 1];
      return Promise.resolve(
        data === undefined
          ? null
          : new TextEncoder().encode(JSON.stringify(data)),
      );
    },
    listVersions: (_type, _modelId, dataName) =>
      Promise.resolve((store.get(dataName) ?? []).map((_, i) => i + 1)),
  };
}

function state(
  workItem: string,
  partial?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    workItem,
    stageId: "review",
    cycles: { planning: 2, review: 2 },
    enteredAt: "2026-06-11T10:00:00.000Z",
    status: "active",
    definitionVersion: 1,
    startedAt: "2026-06-11T09:00:00.000Z",
    ...partial,
  };
}

function artifact(
  workItem: string,
  name: string,
  cycle: number,
  payload: Record<string, unknown>,
  recordedAt = "2026-06-11T10:05:00.000Z",
): Record<string, unknown> {
  return {
    name,
    workItem,
    stageId: "review",
    cycle,
    payload,
    recordedAt,
  };
}

Deno.test("workItemSlug: name-safe refs pass through, lossy refs get a stable hash", () => {
  assertEquals(workItemSlug("ISSUE-42"), "ISSUE-42");
  assertEquals(workItemSlug("issue_42.b"), "issue_42.b");
  const url = workItemSlug("https://tracker/x?id=1");
  assert(url.includes("https-tracker-x-id-1"));
  assert(/[0-9a-f]{8}$/.test(url));
  // Deterministic, and distinct refs that sanitize alike stay distinct.
  assertEquals(url, workItemSlug("https://tracker/x?id=1"));
  assertNotEquals(
    workItemSlug("a/b"),
    workItemSlug("a?b"),
  );
});

Deno.test("loadRunView: scoped to one work item's slug-namespaced records", async () => {
  const repo = memoryRepository({
    "state-ISSUE-1": [state("ISSUE-1")],
    "state-ISSUE-2": [state("ISSUE-2", { stageId: "planning" })],
    "artifact-ISSUE-1-plan": [
      artifact("ISSUE-1", "plan", 1, { v: 1 }),
      artifact("ISSUE-1", "plan", 2, { v: 2 }),
    ],
    "artifact-ISSUE-2-plan": [
      artifact("ISSUE-2", "plan", 1, { v: "other" }),
    ],
    "evidence-ISSUE-1-change-request": [
      {
        name: "change-request",
        workItem: "ISSUE-1",
        stageId: "review",
        cycle: 2,
        payload: { url: "http://x" },
        recordedAt: "2026-06-11T10:06:00.000Z",
      },
    ],
    "approval-ISSUE-1-plan-approval": [
      {
        gateId: "plan-approval",
        workItem: "ISSUE-1",
        decision: "rejected",
        actor: "adam",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-06-11T10:07:00.000Z",
      },
      {
        gateId: "plan-approval",
        workItem: "ISSUE-1",
        decision: "approved",
        actor: "adam",
        stageId: "review",
        cycle: 2,
        decidedAt: "2026-06-11T10:08:00.000Z",
      },
    ],
  });

  const view = await loadRunView(repo, "type", "id", "ISSUE-1");
  assertEquals(view.state?.workItem, "ISSUE-1");
  assertEquals(view.artifacts.get("plan")?.version, 2);
  assertEquals(view.artifacts.get("plan")?.latest.payload, { v: 2 });
  assertEquals(view.evidence.get("change-request")?.latest.cycle, 2);
  const approvals = view.approvals.get("plan-approval");
  assertEquals(approvals?.length, 1);
  assertEquals(approvals?.[0].decision, "approved");
  assertEquals(
    view.approvalHistory.get("plan-approval")?.map((approval) =>
      approval.resourceVersion
    ),
    [1, 2],
  );

  // ISSUE-2's view is fully independent — no version interleaving.
  const other = await loadRunView(repo, "type", "id", "ISSUE-2");
  assertEquals(other.state?.stageId, "planning");
  assertEquals(other.artifacts.get("plan")?.version, 1);
  assertEquals(other.artifacts.get("plan")?.latest.payload, { v: "other" });
  assertEquals(other.evidence.size, 0);
  assertEquals(other.approvals.size, 0);
});

Deno.test("loadRunView: era filtering hides records from before a reset", async () => {
  const repo = memoryRepository({
    // startedAt is AFTER the artifact and the first approval were recorded
    // (i.e. the run was reset at 11:00).
    "state-ISSUE-1": [
      state("ISSUE-1", {
        startedAt: "2026-06-11T11:00:00.000Z",
        cycles: { review: 1 },
      }),
    ],
    "artifact-ISSUE-1-plan": [
      artifact("ISSUE-1", "plan", 1, { v: 1 }, "2026-06-11T10:05:00.000Z"),
    ],
    "evidence-ISSUE-1-change-request": [
      {
        name: "change-request",
        workItem: "ISSUE-1",
        stageId: "review",
        cycle: 1,
        payload: {},
        recordedAt: "2026-06-11T12:00:00.000Z", // after reset — kept
      },
    ],
    "approval-ISSUE-1-plan-approval": [
      {
        gateId: "plan-approval",
        workItem: "ISSUE-1",
        decision: "approved",
        actor: "adam",
        stageId: "review",
        cycle: 1,
        decidedAt: "2026-06-11T10:30:00.000Z", // pre-reset — hidden
      },
    ],
  });

  const view = await loadRunView(repo, "type", "id", "ISSUE-1");
  assertEquals(view.artifacts.size, 0, "pre-reset artifact must be hidden");
  assertEquals(view.evidence.get("change-request")?.latest.cycle, 1);
  assertEquals(view.approvals.size, 0, "pre-reset approval must be hidden");
});

Deno.test("loadRunView: empty store yields empty view", async () => {
  const view = await loadRunView(memoryRepository(), "type", "id", "X-1");
  assertEquals(view.state, null);
  assertEquals(view.artifacts.size, 0);
  assertEquals(view.evidence.size, 0);
  assertEquals(view.approvals.size, 0);
});

Deno.test("loadRunView: approval history requires the exact opaque work item, not its slug literal", async () => {
  const opaqueWorkItem = "https://tracker.test/work items/1";
  const slug = workItemSlug(opaqueWorkItem);
  const repo = memoryRepository({
    [`approval-${slug}-plan-approval`]: [{
      gateId: "plan-approval",
      workItem: slug,
      decision: "approved",
      actor: "forged",
      stageId: "review",
      cycle: 1,
      decidedAt: "2026-01-01T00:00:00.000Z",
    }],
  });

  const view = await loadRunView(
    repo,
    "type",
    "id",
    slug,
    opaqueWorkItem,
  );
  assertEquals(view.approvals.size, 0);
  assertEquals(view.approvalHistory.size, 0);
  assertEquals(
    view.approvalHistoryIssues.get("plan-approval")?.[0].kind,
    "unavailable",
  );
});

Deno.test("loadAllRunStates: overview across all work items", async () => {
  const repo = memoryRepository({
    "state-ISSUE-2": [state("ISSUE-2", { stageId: "planning" })],
    "state-ISSUE-1": [
      state("ISSUE-1", { stageId: "planning" }),
      state("ISSUE-1"),
    ],
    "artifact-ISSUE-1-plan": [artifact("ISSUE-1", "plan", 1, {})],
  });
  const states = await loadAllRunStates(repo, "type", "id");
  assertEquals(states.map((s) => s.workItem), ["ISSUE-1", "ISSUE-2"]);
  assertEquals(states[0].stageId, "review"); // latest version wins
});

Deno.test("currentCycle and entriesInto", () => {
  const s = {
    workItem: "ISSUE-1",
    stageId: "review",
    cycles: { planning: 2, review: 2 },
    enteredAt: "2026-06-11T10:00:00.000Z",
    status: "active" as const,
    definitionVersion: 1,
    startedAt: "2026-06-11T09:00:00.000Z",
  };
  assertEquals(currentCycle(s), 2);
  assertEquals(entriesInto(s, "planning"), 2);
  assertEquals(entriesInto(s, "never"), 0);
});
