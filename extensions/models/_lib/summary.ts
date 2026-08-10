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

import type {
  ArtifactEnvelope,
  EvidenceEnvelope,
  JournalEntry,
  RunState,
} from "./run_data.ts";
import {
  artifactInstance,
  evidenceInstance,
  journalInstance,
  stateInstance,
} from "./run_names.ts";

// ---------------------------------------------------------------------------
// Work-item summary: a statically-rendered, linear history of one work
// item's run, reconstructed from the journal (the spine: one event per
// version) joined with the versioned artifact / evidence records (the
// flesh: full payloads). No LLM is involved anywhere — the same run data
// always renders the same report.
//
// This module is deliberately zod-free (type-only imports from run_data):
// the work-item-summary report bundles it, and report bundles cannot
// resolve bare npm specifiers. Decoded content is shape-checked with the
// structural guards below instead.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Data access: a minimal reader over swamp's data query / repository
// library interfaces. Production `findAllForModel` only surfaces the
// latest version per name, so version enumeration goes through the data
// query catalog (CEL, `version > 0` opts into history) or
// `listVersions` — never findAllForModel.
// ---------------------------------------------------------------------------

export interface RunDataReader {
  /** Every stored version of a data name, ascending. */
  versionsOf(name: string): Promise<number[]>;
  /** Parsed JSON content of one version (latest when omitted). */
  read(
    name: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
}

/** The content-fetch slice both readers need. */
interface ContentRepositoryLike {
  getContent(
    type: unknown,
    modelId: string,
    dataName: string,
    version?: number,
  ): Promise<Uint8Array | null>;
  listVersions?(
    type: unknown,
    modelId: string,
    dataName: string,
  ): Promise<number[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(
  repo: ContentRepositoryLike,
  modelType: unknown,
  modelId: string,
  name: string,
  version?: number,
): Promise<Record<string, unknown> | null> {
  const content = await repo.getContent(modelType, modelId, name, version);
  if (content === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(content));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Reader backed by swamp's data query service (the `swamp data query`
 * facility): version discovery via a CEL predicate over the catalog —
 * referencing `version` opts into full history — and payloads via
 * `getContent`. Preferred whenever a queryData binding is available.
 * The catalog predicate language scopes by modelName/modelType (it has no
 * modelId field).
 */
export function queryRunDataReader(opts: {
  queryData: (predicate: string) => Promise<unknown[]>;
  dataRepository: ContentRepositoryLike;
  modelType: unknown;
  modelId: string;
  /** The model instance's definition name (`self.name`). */
  modelName: string;
}): RunDataReader {
  return {
    versionsOf: async (name) => {
      const records = await opts.queryData(
        `modelType == "${
          String(opts.modelType)
        }" && modelName == "${opts.modelName}" && name == "${name}" && version > 0`,
      );
      return records
        .map((record) => (isRecord(record) ? record.version : undefined))
        .filter((version): version is number => typeof version === "number")
        .sort((a, b) => a - b);
    },
    read: (name, version) =>
      readJson(
        opts.dataRepository,
        opts.modelType,
        opts.modelId,
        name,
        version,
      ),
  };
}

/**
 * Reader backed directly by the data repository's `listVersions` /
 * `getContent`. Used where no query service is exposed (report contexts).
 */
export function repositoryRunDataReader(opts: {
  dataRepository: ContentRepositoryLike;
  modelType: unknown;
  modelId: string;
}): RunDataReader {
  return {
    versionsOf: (name) => {
      if (opts.dataRepository.listVersions === undefined) {
        throw new Error(
          "data repository does not support listVersions; provide a queryData binding instead",
        );
      }
      return opts.dataRepository.listVersions(
        opts.modelType,
        opts.modelId,
        name,
      );
    },
    read: (name, version) =>
      readJson(
        opts.dataRepository,
        opts.modelType,
        opts.modelId,
        name,
        version,
      ),
  };
}

// ---------------------------------------------------------------------------
// Structural guards (zod-free shape checks for decoded run data).
// Tolerant by design: invalid records are skipped, never fatal.
// ---------------------------------------------------------------------------

function asRunState(value: Record<string, unknown> | null): RunState | null {
  if (value === null) return null;
  if (
    typeof value.workItem !== "string" ||
    typeof value.stageId !== "string" ||
    (value.status !== "active" && value.status !== "terminal") ||
    typeof value.definitionVersion !== "number" ||
    typeof value.enteredAt !== "string" ||
    typeof value.startedAt !== "string" ||
    !isRecord(value.cycles)
  ) {
    return null;
  }
  return value as unknown as RunState;
}

function asJournalEntry(
  value: Record<string, unknown> | null,
): JournalEntry | null {
  if (value === null) return null;
  if (
    typeof value.event !== "string" ||
    typeof value.workItem !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.at !== "string"
  ) {
    return null;
  }
  if (value.stageId !== undefined && typeof value.stageId !== "string") {
    return null;
  }
  if (value.payload !== undefined && !isRecord(value.payload)) return null;
  return value as unknown as JournalEntry;
}

function asEnvelope(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    typeof value.name !== "string" ||
    typeof value.workItem !== "string" ||
    typeof value.stageId !== "string" ||
    typeof value.cycle !== "number" ||
    typeof value.recordedAt !== "string" ||
    !isRecord(value.payload)
  ) {
    return null;
  }
  return value;
}

function asArtifactEnvelope(
  value: Record<string, unknown> | null,
): ArtifactEnvelope | null {
  const envelope = asEnvelope(value);
  if (envelope === null) return null;
  if (
    envelope.subjectVersion !== undefined &&
    typeof envelope.subjectVersion !== "number"
  ) {
    return null;
  }
  if (envelope.note !== undefined && typeof envelope.note !== "string") {
    return null;
  }
  return envelope as unknown as ArtifactEnvelope;
}

function asEvidenceEnvelope(
  value: Record<string, unknown> | null,
): EvidenceEnvelope | null {
  const envelope = asEnvelope(value);
  return envelope === null ? null : envelope as unknown as EvidenceEnvelope;
}

// ---------------------------------------------------------------------------
// History loading: the journal names every record the run ever touched, so
// loading is journal-driven — read all journal versions, then fetch every
// version of each referenced artifact/evidence record.
// ---------------------------------------------------------------------------

export interface RunHistory {
  slug: string;
  state: RunState | null;
  /** Journal entries oldest-first, with their version numbers. */
  journal: { version: number; entry: JournalEntry }[];
  /** True when the journal's earliest versions were garbage-collected. */
  journalTruncated: boolean;
  /** Logical artifact name → version → envelope (missing = GC'd). */
  artifactVersions: Map<string, Map<number, ArtifactEnvelope>>;
  /** Logical evidence name → version → envelope (missing = GC'd). */
  evidenceVersions: Map<string, Map<number, EvidenceEnvelope>>;
}

export async function loadRunHistory(
  reader: RunDataReader,
  slug: string,
): Promise<RunHistory> {
  const history: RunHistory = {
    slug,
    state: null,
    journal: [],
    journalTruncated: false,
    artifactVersions: new Map(),
    evidenceVersions: new Map(),
  };

  history.state = asRunState(await reader.read(stateInstance(slug)));

  const journalName = journalInstance(slug);
  const journalVersions = await reader.versionsOf(journalName);
  history.journalTruncated = journalVersions.length > 0 &&
    journalVersions[0] > 1;
  for (const version of journalVersions) {
    const entry = asJournalEntry(await reader.read(journalName, version));
    if (entry === null) {
      history.journalTruncated = true;
      continue;
    }
    history.journal.push({ version, entry });
  }

  // Names referenced by the surviving journal events.
  const artifactNames = new Set<string>();
  const evidenceNames = new Set<string>();
  for (const { entry } of history.journal) {
    const payload = entry.payload ?? {};
    if (
      entry.event === "artifact_recorded" && typeof payload.name === "string"
    ) {
      artifactNames.add(payload.name);
    }
    if (
      entry.event === "findings_resolved" &&
      typeof payload.artifact === "string"
    ) {
      artifactNames.add(payload.artifact);
    }
    if (
      entry.event === "evidence_recorded" && typeof payload.name === "string"
    ) {
      evidenceNames.add(payload.name);
    }
  }

  for (const name of artifactNames) {
    const instance = artifactInstance(slug, name);
    const perVersion = new Map<number, ArtifactEnvelope>();
    for (const version of await reader.versionsOf(instance)) {
      const envelope = asArtifactEnvelope(await reader.read(instance, version));
      if (envelope !== null) perVersion.set(version, envelope);
    }
    history.artifactVersions.set(name, perVersion);
  }

  for (const name of evidenceNames) {
    const instance = evidenceInstance(slug, name);
    const perVersion = new Map<number, EvidenceEnvelope>();
    for (const version of await reader.versionsOf(instance)) {
      const envelope = asEvidenceEnvelope(await reader.read(instance, version));
      if (envelope !== null) perVersion.set(version, envelope);
    }
    history.evidenceVersions.set(name, perVersion);
  }

  return history;
}

// ---------------------------------------------------------------------------
// Timeline: the journal replayed into stage visits with enriched events.
// ---------------------------------------------------------------------------

export interface TimelineEvent {
  at: string;
  kind: "artifact" | "evidence" | "findings_resolved" | "approval" | "note";
  /** The journal's own one-line summary — the fallback narration. */
  summary: string;
  artifact?: {
    name: string;
    version?: number;
    available: boolean;
    isFindings: boolean;
    payload?: Record<string, unknown>;
    note?: string;
    subjectName?: string;
    subjectVersion?: number;
  };
  evidence?: {
    name: string;
    version?: number;
    available: boolean;
    payload?: Record<string, unknown>;
  };
  resolutions?: { findingId: string; note: string }[];
  resolutionsArtifact?: string;
  approval?: {
    gateId: string;
    decision: "approved" | "rejected";
    actor: string;
    note?: string;
    /**
     * Whether the decision was bound to a computed subject digest. Absent on
     * decisions journaled before subject binding existed — rendered as
     * "unbound (legacy)" rather than silently as if it were bound, because the
     * difference is exactly what an auditor is reading the report for.
     */
    subjectStatus?: "bound" | "unbound";
    subjectDigest?: string;
    subjectAlgorithm?: string;
  };
}

export interface StageVisit {
  stageId: string;
  cycle: number;
  enteredAt: string;
  leftAt?: string;
  /** "start", "reset", or the transition name that entered this stage. */
  enteredVia: string;
  exit?: { transition: string; to: string; terminal: boolean };
  /** True when this visit begins a new era (after a reset). */
  eraStart?: boolean;
  terminal?: boolean;
  events: TimelineEvent[];
}

export interface TimelineTotals {
  events: number;
  stageVisits: number;
  artifactsRecorded: number;
  evidenceRecorded: number;
  findingsTotal: number;
  findingsResolved: number;
  approvals: number;
  rejections: number;
  resets: number;
}

export interface WorkItemTimeline {
  workItem: string;
  factoryName?: string;
  definitionVersion?: number;
  runStatus: "active" | "terminal" | "unknown";
  currentStageId?: string;
  startedAt?: string;
  endedAt?: string;
  path: string[];
  visits: StageVisit[];
  journalTruncated: boolean;
  totals: TimelineTotals;
}

export interface TimelineOptions {
  factoryName?: string;
  /** Artifact name → the artifact it reviews (from the definition). */
  reviews?: Map<string, string>;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * One-line description of what an approval bound to, for the report. Three
 * distinguishable states — bound to a digest, deliberately unbound, and
 * recorded before binding existed — because collapsing the last two would
 * misreport a legacy sign-off as a considered choice not to bind.
 */
export function describeApprovalBinding(approval: {
  subjectStatus?: "bound" | "unbound";
  subjectDigest?: string;
  subjectAlgorithm?: string;
}): string {
  if (
    approval.subjectStatus === "bound" && approval.subjectDigest !== undefined
  ) {
    const algorithm = approval.subjectAlgorithm ?? "sha-256";
    return `bound — ${algorithm}:${approval.subjectDigest.slice(0, 12)}`;
  }
  if (approval.subjectStatus === "unbound") {
    return "unbound — the gate declares no subject binding";
  }
  return "unbound (legacy) — recorded before subject binding existed";
}

/**
 * Binding status of a journaled approval. Journal entries written before
 * subject binding existed carry neither field, and are reported as undefined
 * (rendered "legacy") rather than defaulted to "unbound" — "we don't know how
 * this was recorded" and "we know it was recorded without a binding" are
 * different claims, and an audit report should not conflate them.
 */
function subjectStatusOf(
  payload: Record<string, unknown>,
): "bound" | "unbound" | undefined {
  const status = str(payload.subjectStatus);
  return status === "bound" || status === "unbound" ? status : undefined;
}

interface FindingShape {
  id?: unknown;
  severity?: unknown;
  category?: unknown;
  description?: unknown;
  resolved?: unknown;
  resolutionNote?: unknown;
}

function findingsOf(
  payload: Record<string, unknown> | undefined,
): FindingShape[] | undefined {
  if (payload === undefined) return undefined;
  const findings = payload.findings;
  if (!Array.isArray(findings)) return undefined;
  if (!findings.every((f) => f !== null && typeof f === "object")) {
    return undefined;
  }
  return findings as FindingShape[];
}

export function buildTimeline(
  history: RunHistory,
  workItem: string,
  options: TimelineOptions = {},
): WorkItemTimeline {
  const visits: StageVisit[] = [];
  const totals: TimelineTotals = {
    events: history.journal.length,
    stageVisits: 0,
    artifactsRecorded: 0,
    evidenceRecorded: 0,
    findingsTotal: 0,
    findingsResolved: 0,
    approvals: 0,
    rejections: 0,
    resets: 0,
  };

  // Ordinal version counters: the k-th write of a record is version k.
  // Journal payloads written by current engine versions carry `version`
  // directly; these counters are the backfill for runs recorded before
  // that, and findings_resolved counts too (resolutions re-write the
  // artifact instance).
  const artifactWrites = new Map<string, number>();
  const evidenceWrites = new Map<string, number>();

  let current: StageVisit | null = null;
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  const openVisit = (visit: StageVisit): StageVisit => {
    const previous = visits[visits.length - 1];
    if (previous !== undefined && previous.leftAt === undefined) {
      previous.leftAt = visit.enteredAt;
    }
    visits.push(visit);
    return visit;
  };

  // Events arriving before any stage-opening event (truncated journal):
  // synthesize a visit from the entry's own stage stamp.
  const ensureVisit = (entry: JournalEntry): StageVisit => {
    if (current === null) {
      current = openVisit({
        stageId: entry.stageId ?? "(unknown)",
        cycle: 1,
        enteredAt: entry.at,
        enteredVia: "(unknown)",
        events: [],
      });
    }
    return current;
  };

  const bump = (counters: Map<string, number>, name: string): number => {
    const next = (counters.get(name) ?? 0) + 1;
    counters.set(name, next);
    return next;
  };

  for (const { entry } of history.journal) {
    const payload = entry.payload ?? {};

    switch (entry.event) {
      case "started": {
        startedAt ??= entry.at;
        current = openVisit({
          stageId: str(payload.stage) ?? entry.stageId ?? "(unknown)",
          cycle: 1,
          enteredAt: entry.at,
          enteredVia: "start",
          events: [],
        });
        break;
      }

      case "reset": {
        totals.resets += 1;
        current = openVisit({
          stageId: entry.stageId ?? "(unknown)",
          cycle: 1,
          enteredAt: entry.at,
          enteredVia: "reset",
          eraStart: true,
          events: [],
        });
        break;
      }

      case "advanced":
      case "run_terminal": {
        const to = str(payload.to) ?? entry.stageId ?? "(unknown)";
        const transition = str(payload.transition) ?? "(unknown)";
        const terminal = entry.event === "run_terminal";
        if (current !== null) {
          current.exit = { transition, to, terminal };
        }
        current = openVisit({
          stageId: to,
          cycle: num(payload.cycle) ?? 1,
          enteredAt: entry.at,
          enteredVia: transition,
          terminal,
          events: [],
        });
        if (terminal) endedAt = entry.at;
        break;
      }

      case "artifact_recorded": {
        const visit = ensureVisit(entry);
        const name = str(payload.name) ?? "(unknown)";
        const version = num(payload.version) ?? bump(artifactWrites, name);
        artifactWrites.set(name, version);
        const envelope = history.artifactVersions.get(name)?.get(version);
        totals.artifactsRecorded += 1;
        visit.events.push({
          at: entry.at,
          kind: "artifact",
          summary: entry.summary,
          artifact: {
            name,
            version,
            available: envelope !== undefined,
            isFindings: findingsOf(envelope?.payload) !== undefined,
            payload: envelope?.payload,
            note: envelope?.note,
            subjectName: options.reviews?.get(name),
            subjectVersion: envelope?.subjectVersion ??
              num(payload.subjectVersion),
          },
        });
        break;
      }

      case "evidence_recorded": {
        const visit = ensureVisit(entry);
        const name = str(payload.name) ?? "(unknown)";
        const version = num(payload.version) ?? bump(evidenceWrites, name);
        evidenceWrites.set(name, version);
        const envelope = history.evidenceVersions.get(name)?.get(version);
        totals.evidenceRecorded += 1;
        visit.events.push({
          at: entry.at,
          kind: "evidence",
          summary: entry.summary,
          evidence: {
            name,
            version,
            available: envelope !== undefined,
            payload: envelope?.payload,
          },
        });
        break;
      }

      case "findings_resolved": {
        const visit = ensureVisit(entry);
        const artifact = str(payload.artifact) ?? "(unknown)";
        // Resolutions re-write the artifact instance, so the version
        // counter advances even though no new recording happened.
        if (num(payload.version) !== undefined) {
          artifactWrites.set(artifact, num(payload.version) as number);
        } else {
          bump(artifactWrites, artifact);
        }
        const resolutions = Array.isArray(payload.resolutions)
          ? (payload.resolutions as { findingId?: unknown; note?: unknown }[])
            .map((r) => ({
              findingId: str(r.findingId) ?? "(unknown)",
              note: str(r.note) ?? "",
            }))
          : [];
        visit.events.push({
          at: entry.at,
          kind: "findings_resolved",
          summary: entry.summary,
          resolutionsArtifact: artifact,
          resolutions,
        });
        break;
      }

      case "approved":
      case "rejected": {
        const visit = ensureVisit(entry);
        if (entry.event === "approved") totals.approvals += 1;
        else totals.rejections += 1;
        visit.events.push({
          at: entry.at,
          kind: "approval",
          summary: entry.summary,
          approval: {
            gateId: str(payload.gateId) ?? "(unknown)",
            decision: entry.event,
            actor: str(payload.actor) ?? "(unknown)",
            note: str(payload.note),
            subjectStatus: subjectStatusOf(payload),
            subjectDigest: str(payload.subjectDigest),
            subjectAlgorithm: str(payload.subjectAlgorithm),
          },
        });
        break;
      }

      default: {
        const visit = ensureVisit(entry);
        visit.events.push({
          at: entry.at,
          kind: "note",
          summary: entry.summary,
        });
      }
    }
  }

  totals.stageVisits = visits.length;

  // Findings totals come from the latest available version of every
  // findings-shaped artifact.
  for (const perVersion of history.artifactVersions.values()) {
    const versions = [...perVersion.keys()].sort((a, b) => a - b);
    if (versions.length === 0) continue;
    const latest = perVersion.get(versions[versions.length - 1]);
    const findings = findingsOf(latest?.payload);
    if (findings === undefined) continue;
    totals.findingsTotal += findings.length;
    totals.findingsResolved += findings.filter((f) =>
      f.resolved === true
    ).length;
  }

  const state = history.state;
  return {
    workItem,
    factoryName: options.factoryName,
    definitionVersion: state?.definitionVersion,
    runStatus: state?.status ?? "unknown",
    currentStageId: state?.stageId,
    startedAt: startedAt ?? state?.startedAt,
    endedAt,
    path: visits.map((v) => v.stageId),
    visits,
    journalTruncated: history.journalTruncated,
    totals,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering — deterministic, shape-driven (payload schemas are
// user-defined, so rendering keys off structure, never artifact names).
// ---------------------------------------------------------------------------

const LONG_STRING = 100;
const JSON_TRUNCATE = 2000;

function fmtTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().replace("T", " ").replace(
    /\.\d+Z$/,
    " UTC",
  );
}

function fmtClock(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toISOString().slice(11, 19);
}

export function fmtDuration(ms: number): string {
  if (ms < 0) return "0s";
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function durationBetween(fromIso: string, toIso: string): string | undefined {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return undefined;
  return fmtDuration(to - from);
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, "<br>");
}

function fencedJson(value: unknown): string {
  let json = JSON.stringify(value, null, 2);
  let note = "";
  if (json.length > JSON_TRUNCATE) {
    json = json.slice(0, JSON_TRUNCATE);
    note = "\n\n_(truncated)_";
  }
  return "```json\n" + json + "\n```" + note;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" ||
    typeof value === "boolean";
}

// One compact block per finding instead of a table: finding descriptions
// are long prose, and wide tables wrap badly in terminal renderers.
function renderFindings(findings: FindingShape[]): string {
  if (findings.length === 0) return "_No findings._";
  return findings.map((f) => {
    const id = isScalar(f.id) ? String(f.id) : "(finding)";
    const meta = [f.severity, f.category].filter(isScalar).map(String);
    const status = f.resolved === true
      ? `✔ ${
        typeof f.resolutionNote === "string" && f.resolutionNote.length > 0
          ? f.resolutionNote
          : "resolved"
      }`
      : "open";
    const head = `**${id}**${
      meta.length > 0 ? ` (${meta.join(", ")})` : ""
    } — ${status}`;
    const description = isScalar(f.description) ? String(f.description) : "";
    return description.length > 0 ? `${head}\n\n${description}` : head;
  }).join("\n\n");
}

function renderObjectArray(
  key: string,
  items: Record<string, unknown>[],
): string {
  // Arrays of objects with a `description` field read as a list of steps.
  // No inline markup (bold, backticks) inside list items — terminal
  // markdown renderers (marked-terminal) emit it literally there.
  if (items.every((item) => typeof item.description === "string")) {
    const lines = items.map((item, index) => {
      const extras = Object.entries(item)
        .filter(([k, v]) => k !== "description" && v !== undefined)
        .map(([k, v]) =>
          `${k}: ${
            Array.isArray(v) && v.every(isScalar)
              ? v.join(", ")
              : isScalar(v)
              ? String(v)
              : JSON.stringify(v)
          }`
        );
      return `${index + 1}. ${item.description}${
        extras.length > 0 ? ` — ${extras.join("; ")}` : ""
      }`;
    });
    return `**${key}:**\n\n${lines.join("\n")}`;
  }

  // Small uniform objects render as a table.
  const keys = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const tabular = keys.length <= 6 &&
    items.every((item) =>
      Object.values(item).every((v) => v === undefined || isScalar(v))
    );
  if (tabular) {
    const header = `| ${keys.join(" | ")} |\n|${
      keys.map(() => " --- ").join("|")
    }|`;
    const rows = items.map((item) =>
      "| " +
      keys.map((k) => escapeCell(item[k] === undefined ? "" : String(item[k])))
        .join(" | ") +
      " |"
    );
    return `**${key}:**\n\n${[header, ...rows].join("\n")}`;
  }

  return `**${key}:**\n\n${fencedJson(items)}`;
}

/**
 * Render an arbitrary payload object as markdown, by shape:
 * a `findings` array becomes per-finding blocks, a `summary` string leads
 * as a plain paragraph, description-bearing object arrays become ordered
 * lists, scalars become bold key/value lines, and anything deeper falls
 * back to fenced JSON.
 */
export function renderPayloadMarkdown(
  payload: Record<string, unknown>,
): string {
  const blocks: string[] = [];

  // Plain paragraph, not a blockquote: terminal markdown renderers
  // (marked-terminal) style blockquotes gray-italic and re-wrap them
  // badly for long single-line summaries.
  const summary = payload.summary;
  if (typeof summary === "string" && summary.length > 0) {
    blocks.push(summary);
  }

  const findings = findingsOf(payload);
  if (findings !== undefined) {
    blocks.push(renderFindings(findings));
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === "summary" && typeof summary === "string") continue;
    if (key === "findings" && findings !== undefined) continue;
    if (value === undefined || value === null) continue;

    if (typeof value === "string") {
      blocks.push(
        value.length > LONG_STRING || value.includes("\n")
          ? `**${key}:**\n\n${value}`
          : `**${key}:** ${value}`,
      );
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      blocks.push(`**${key}:** ${value}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (value.every(isScalar)) {
        const rendered = value.map((v) => `\`${v}\``).join(", ");
        blocks.push(`**${key}:** ${rendered}`);
        continue;
      }
      if (
        value.every((v) =>
          v !== null && typeof v === "object" && !Array.isArray(v)
        )
      ) {
        blocks.push(renderObjectArray(key, value as Record<string, unknown>[]));
        continue;
      }
      blocks.push(`**${key}:**\n\n${fencedJson(value)}`);
      continue;
    }
    blocks.push(`**${key}:**\n\n${fencedJson(value)}`);
  }

  return blocks.join("\n\n");
}

function renderEvidencePayload(payload: Record<string, unknown>): string {
  const blocks: string[] = [];
  const status = payload.status;
  if (isScalar(status)) {
    blocks.push(`**status:** \`${status}\``);
  }
  const rest = Object.fromEntries(
    Object.entries(payload).filter(([k]) => k !== "status"),
  );
  if (Object.keys(rest).length > 0) {
    const allScalar = Object.values(rest).every(isScalar);
    blocks.push(
      allScalar
        ? Object.entries(rest).map(([k, v]) => `**${k}:** \`${v}\``).join(" · ")
        : renderPayloadMarkdown(rest),
    );
  }
  return blocks.join("\n");
}

function renderEvent(event: TimelineEvent): string {
  switch (event.kind) {
    case "artifact": {
      const a = event.artifact;
      if (a === undefined) return `- ${event.summary}`;
      const icon = a.isFindings ? "🔍" : "📄";
      const label = a.isFindings ? "Review" : "Artifact";
      const reviews = a.subjectVersion !== undefined
        ? `, reviews ${a.subjectName ?? "subject"} v${a.subjectVersion}`
        : "";
      const heading =
        `### ${icon} ${label}: ${a.name} (v${a.version}${reviews})`;
      const parts = [heading];
      if (a.note !== undefined && a.note.length > 0) {
        parts.push(`_${a.note}_`);
      }
      parts.push(
        a.available && a.payload !== undefined
          ? renderPayloadMarkdown(a.payload)
          : `_Content no longer available (garbage-collected). Journal: ${event.summary}_`,
      );
      return parts.join("\n\n");
    }

    case "evidence": {
      const e = event.evidence;
      if (e === undefined) return `- ${event.summary}`;
      const heading = `### 🧪 Evidence: ${e.name}`;
      const body = e.available && e.payload !== undefined
        ? renderEvidencePayload(e.payload)
        : `_Content no longer available (garbage-collected). Journal: ${event.summary}_`;
      return `${heading}\n\n${body}`;
    }

    case "findings_resolved": {
      const heading = `### 🛠 Findings resolved in ${
        event.resolutionsArtifact ?? "(unknown)"
      }`;
      // No inline markup inside list items — terminal markdown renderers
      // (marked-terminal) emit it literally there.
      const lines = (event.resolutions ?? []).map((r) =>
        `- ${r.findingId} — ${r.note}`
      );
      return `${heading}\n\n${lines.join("\n") || event.summary}`;
    }

    case "approval": {
      const a = event.approval;
      if (a === undefined) return `- ${event.summary}`;
      const icon = a.decision === "approved" ? "✅" : "❌";
      const label = a.decision === "approved" ? "Approval" : "Rejection";
      const heading =
        `### ${icon} ${label}: ${a.gateId} — **${a.decision}** by ${a.actor}`;
      // What the decision was a decision *of*. An audit reader needs to tell a
      // subject-bound sign-off from one that only filled a slot, so say which
      // it was on every rendered decision rather than only the bound ones.
      const parts = [heading];
      parts.push(`Subject: ${describeApprovalBinding(a)}`);
      if (a.note !== undefined && a.note.length > 0) parts.push(`“${a.note}”`);
      return parts.join("\n\n");
    }

    case "note":
      return `- ${fmtClock(event.at)} — ${event.summary}`;
  }
}

export function renderSummaryMarkdown(timeline: WorkItemTimeline): string {
  const lines: string[] = [];
  lines.push(`# Work Item: ${timeline.workItem}`);
  lines.push("");

  const headerBits: string[] = [];
  if (timeline.factoryName !== undefined) {
    headerBits.push(`**Factory:** ${timeline.factoryName}`);
  }
  if (timeline.definitionVersion !== undefined) {
    headerBits.push(`**Definition:** v${timeline.definitionVersion}`);
  }
  if (headerBits.length > 0) lines.push(headerBits.join(" · "), "");

  if (timeline.startedAt !== undefined) {
    let when = `**Started:** ${fmtTime(timeline.startedAt)}`;
    if (timeline.endedAt !== undefined) {
      const elapsed = durationBetween(timeline.startedAt, timeline.endedAt);
      when += ` · **Completed:** ${fmtTime(timeline.endedAt)}` +
        (elapsed !== undefined ? ` (${elapsed})` : "");
    }
    lines.push(when, "");
  }

  if (timeline.runStatus === "terminal") {
    lines.push(
      `**Outcome:** 🏁 terminal at \`${timeline.currentStageId}\``,
      "",
    );
  } else if (timeline.runStatus === "active") {
    const visit = timeline.visits[timeline.visits.length - 1];
    lines.push(
      `**Currently:** active at \`${timeline.currentStageId}\`` +
        (visit !== undefined ? ` (cycle ${visit.cycle})` : ""),
      "",
    );
  }

  if (timeline.path.length > 0) {
    lines.push(`**Path:** ${timeline.path.join(" → ")}`, "");
  }

  const t = timeline.totals;
  const totalBits = [
    `${t.events} events`,
    `${t.stageVisits} stage visits`,
    `${t.artifactsRecorded} artifacts recorded`,
  ];
  if (t.evidenceRecorded > 0) {
    totalBits.push(`${t.evidenceRecorded} evidence records`);
  }
  if (t.approvals + t.rejections > 0) {
    totalBits.push(
      `${t.approvals} approvals` +
        (t.rejections > 0 ? `, ${t.rejections} rejections` : ""),
    );
  }
  if (t.findingsTotal > 0) {
    totalBits.push(
      `${t.findingsTotal} findings (${t.findingsResolved} resolved)`,
    );
  }
  if (t.resets > 0) totalBits.push(`${t.resets} resets`);
  lines.push(totalBits.join(" · "), "");

  if (timeline.journalTruncated) {
    lines.push(
      "_The earliest journal entries were garbage-collected; this history" +
        " begins at the oldest surviving event._",
      "",
    );
  }

  timeline.visits.forEach((visit, index) => {
    if (visit.eraStart === true) {
      lines.push("---", "");
      lines.push(
        `_Run reset at ${
          fmtTime(visit.enteredAt)
        } — history continues in a new era._`,
        "",
      );
    }

    const elapsed = visit.leftAt !== undefined
      ? durationBetween(visit.enteredAt, visit.leftAt)
      : undefined;
    lines.push(
      `## ${index + 1}. ${visit.stageId} (cycle ${visit.cycle})` +
        (elapsed !== undefined ? ` — ${elapsed}` : ""),
      "",
    );

    if (visit.terminal === true) {
      lines.push(
        `Run reached this terminal stage at ${fmtTime(visit.enteredAt)}.`,
        "",
      );
    } else {
      lines.push(
        `_Entered ${fmtClock(visit.enteredAt)} via ${
          visit.enteredVia === "start" || visit.enteredVia === "reset"
            ? visit.enteredVia
            : `**${visit.enteredVia}**`
        }_`,
        "",
      );
    }

    for (const event of visit.events) {
      lines.push(renderEvent(event), "");
    }

    if (visit.exit !== undefined) {
      lines.push(
        `**→ ${visit.exit.transition}** to *${visit.exit.to}*` +
          (visit.exit.terminal ? " (terminal)" : ""),
        "",
      );
    }
  });

  return lines.join("\n").replaceAll(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Artifact name → the artifact it reviews, extracted from a definition's
 * stages. Accepts unknown input (the report reads raw definition data, the
 * method passes parsed FactoryArguments); definitions are optional context
 * for the summary (the history renders without one), so this never throws.
 */
export function reviewsFromStages(stages: unknown): Map<string, string> {
  const reviews = new Map<string, string>();
  if (!Array.isArray(stages)) return reviews;
  for (const stage of stages) {
    if (stage === null || typeof stage !== "object") continue;
    const artifacts = (stage as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (artifact === null || typeof artifact !== "object") continue;
      const { name, reviews: subject } = artifact as {
        name?: unknown;
        reviews?: unknown;
      };
      if (typeof name === "string" && typeof subject === "string") {
        reviews.set(name, subject);
      }
    }
  }
  return reviews;
}

/**
 * One-stop assembly: load the history, build the timeline, render markdown.
 * Used identically by the `summary` method and the work-item-summary report
 * so both render byte-identical output.
 */
export async function buildWorkItemSummary(
  reader: RunDataReader,
  workItem: string,
  slug: string,
  options: TimelineOptions = {},
): Promise<
  { timeline: WorkItemTimeline; markdown: string; history: RunHistory }
> {
  const history = await loadRunHistory(reader, slug);
  const timeline = buildTimeline(history, workItem, options);
  return { timeline, markdown: renderSummaryMarkdown(timeline), history };
}
