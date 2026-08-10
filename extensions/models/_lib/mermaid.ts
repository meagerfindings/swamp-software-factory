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

import type { FactoryArguments } from "./definition_schema.ts";
import { maxCyclesFor } from "./definition_schema.ts";

// ---------------------------------------------------------------------------
// Human-facing rendering of a factory definition: a Mermaid state diagram
// plus gate and artifact tables. What a human reviews before trusting a
// factory.
// ---------------------------------------------------------------------------

function nodeId(stageId: string): string {
  return stageId.replaceAll("-", "_");
}

export function renderMermaid(args: FactoryArguments): string {
  const lines: string[] = ["flowchart TD"];
  for (const stage of args.stages) {
    const id = nodeId(stage.id);
    if (stage.terminal === true) {
      lines.push(`  ${id}([${stage.id}])`);
    } else if (stage.initial === true) {
      lines.push(`  ${id}[[${stage.id}]]`);
    } else {
      lines.push(`  ${id}[${stage.id}]`);
    }
  }
  for (const stage of args.stages) {
    for (const t of stage.transitions ?? []) {
      const gateCount = (t.gates ?? []).length;
      const label = gateCount > 0 ? `${t.name} (${gateCount} gates)` : t.name;
      lines.push(`  ${nodeId(stage.id)} -->|${label}| ${nodeId(t.to)}`);
    }
  }
  for (const t of args.globalTransitions ?? []) {
    lines.push(`  %% global: any non-terminal -->|${t.name}| ${nodeId(t.to)}`);
  }
  return lines.join("\n");
}

export function renderTables(args: FactoryArguments): string {
  const lines: string[] = [];
  lines.push("| Stage | Mode | Max cycles | Artifacts | Evidence |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const stage of args.stages) {
    const mode = stage.terminal === true
      ? "(terminal)"
      : stage.work?.mode ?? "-";
    const artifacts = (stage.artifacts ?? []).map((a) => a.name).join(", ") ||
      "-";
    const evidence = [
      ...(stage.evidence ?? []).map((e) => e.name),
      ...(stage.work?.resultEvidence !== undefined
        ? [stage.work.resultEvidence]
        : []),
    ].join(", ") || "-";
    lines.push(
      `| ${stage.id} | ${mode} | ${
        maxCyclesFor(stage)
      } | ${artifacts} | ${evidence} |`,
    );
  }
  lines.push("");
  lines.push("| Transition | From | To | Gates |");
  lines.push("| --- | --- | --- | --- |");
  for (const stage of args.stages) {
    for (const t of stage.transitions ?? []) {
      const gates = (t.gates ?? []).map((g) => g.type).join(", ") || "-";
      lines.push(`| ${t.name} | ${stage.id} | ${t.to} | ${gates} |`);
    }
  }
  for (const t of args.globalTransitions ?? []) {
    const gates = (t.gates ?? []).map((g) => g.type).join(", ") || "-";
    lines.push(`| ${t.name} | (any) | ${t.to} | ${gates} |`);
  }
  return lines.join("\n");
}
