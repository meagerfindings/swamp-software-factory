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

/**
 * Work-item summary report for @swamp/software-factory.
 *
 * Fires after the factory's `summary` method and persists the same
 * statically-rendered markdown history the method logs — every stage visit,
 * artifact version, finding, approval, and transition, reconstructed from
 * the journal and the versioned run records. No LLM is involved: the same
 * run data always renders the same report. The JSON twin is the structured
 * timeline.
 *
 * @module
 */

import { workItemSlug } from "../models/_lib/run_names.ts";
import {
  buildWorkItemSummary,
  repositoryRunDataReader,
  reviewsFromStages,
} from "../models/_lib/summary.ts";

/** Structural slice of swamp's MethodReportContext. */
interface ReportContext {
  scope: string;
  modelType: unknown;
  modelId: string;
  methodName: string;
  executionStatus: "succeeded" | "failed";
  errorMessage?: string;
  methodArgs: Record<string, unknown>;
  definition?: { name?: string };
  dataRepository: {
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
  };
  definitionRepository?: {
    findById(
      modelType: unknown,
      id: string,
    ): Promise<{ globalArguments?: Record<string, unknown> } | null>;
  };
}

const FACTORY_TYPE = "@mgreten/software-factory";

/**
 * Renders the recorded history for successful or failed factory summary calls.
 */
export const report = {
  name: "@mgreten/software-factory/work-item-summary",
  description:
    "Linear implementation history of a factory work item, rendered statically from its recorded run data",
  scope: "method",
  labels: ["software-factory"],
  execute: async (
    context: ReportContext,
  ): Promise<{ markdown: string; json: Record<string, unknown> }> => {
    if (
      String(context.modelType) !== FACTORY_TYPE ||
      context.methodName !== "summary"
    ) {
      return { markdown: "", json: {} };
    }
    const workItem = context.methodArgs.workItem;
    if (typeof workItem !== "string" || workItem.length === 0) {
      return { markdown: "", json: {} };
    }
    // Reports also run on the failure path; persist the reason rather
    // than an empty placeholder version.
    if (context.executionStatus !== "succeeded") {
      const error = context.errorMessage ?? "unknown error";
      return {
        markdown: `# Work Item: ${workItem}\n\n_Summary failed: ${error}_\n`,
        json: { workItem, error },
      };
    }

    // The definition only supplies cosmetic context (the reviews map);
    // a missing or unparsable definition must not block the render.
    let reviews = new Map<string, string>();
    try {
      const definition = await context.definitionRepository?.findById(
        context.modelType,
        context.modelId,
      );
      reviews = reviewsFromStages(definition?.globalArguments?.stages);
    } catch {
      // render without subject names
    }

    // Report contexts expose the data repository but no query service;
    // listVersions is the version-accurate library interface there.
    const reader = repositoryRunDataReader({
      dataRepository: context.dataRepository,
      modelType: context.modelType,
      modelId: context.modelId,
    });
    const { timeline, markdown } = await buildWorkItemSummary(
      reader,
      workItem,
      workItemSlug(workItem),
      { factoryName: context.definition?.name, reviews },
    );
    return {
      markdown,
      json: timeline as unknown as Record<string, unknown>,
    };
  },
};
