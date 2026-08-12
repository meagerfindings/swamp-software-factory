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

import type { RunView } from "./run_data.ts";

// ---------------------------------------------------------------------------
// Run-data bindings: `${{ data.latest(self.name, "artifact-plan").payload.x }}`
// strings inside stage config, written in the platform's own CEL syntax and
// left unresolved by the platform until the engine evaluates them at stage
// execution time. The engine registers a `data` receiver backed by the run's
// own resources, so the user-facing language is identical to platform CEL.
// ---------------------------------------------------------------------------

/** Receiver registered as `data` in binding-evaluation CEL contexts. */
export class RunDataReceiver {
  constructor(
    private readonly selfName: string,
    private readonly view: RunView,
  ) {}

  /**
   * `data.latest(modelName, dataName)` over the run's own records. Returns
   * the stored envelope (with `payload`) or null. Only the run's own model
   * is readable here — cross-model reads belong to the platform layer.
   */
  latest(modelName: string, dataName: string): Record<string, unknown> | null {
    if (modelName !== this.selfName) return null;
    if (dataName.startsWith("artifact-")) {
      const view = this.view.artifacts.get(dataName.slice("artifact-".length));
      return view !== undefined
        ? { ...view.latest, version: view.version }
        : null;
    }
    if (dataName.startsWith("evidence-")) {
      const view = this.view.evidence.get(dataName.slice("evidence-".length));
      return view !== undefined
        ? { ...view.latest, version: view.version }
        : null;
    }
    if (dataName.startsWith("validation-")) {
      const view = this.view.validations.get(
        dataName.slice("validation-".length),
      );
      return view !== undefined
        ? { ...view.latest, version: view.version }
        : null;
    }
    return null;
  }
}

/** Minimal CEL environment surface for binding evaluation. */
export interface BindingEnvironmentLike {
  evaluate(expression: string, context: Record<string, unknown>): unknown;
  registerType?(name: string, type: unknown): void;
  registerFunction?(signature: string, fn: unknown): void;
}

/**
 * Prepare a CEL environment for binding evaluation: register the RunData
 * receiver so `data.latest(...)` resolves against run resources, and return
 * the evaluation context (data + self).
 */
export function prepareBindingEnvironment(
  env: BindingEnvironmentLike,
  selfName: string,
  selfExtras: Record<string, unknown>,
  view: RunView,
): Record<string, unknown> {
  const receiver = new RunDataReceiver(selfName, view);
  if (env.registerType !== undefined && env.registerFunction !== undefined) {
    env.registerType("RunDataReceiver", RunDataReceiver);
    env.registerFunction(
      "RunDataReceiver.latest(string, string): dyn",
      (r: RunDataReceiver, modelName: string, dataName: string) =>
        r.latest(modelName, dataName),
    );
  }
  return {
    data: receiver,
    // `name` is engine-owned. Keep it authoritative even if a caller passes a
    // colliding extra; stage binding callers likewise supply only trusted run
    // state as extras, never authored input or global-argument objects.
    self: { ...selfExtras, name: selfName },
  };
}

const EXPRESSION_PATTERN = /\$\{\{([\s\S]*?)\}\}/g;

export interface UnresolvedBinding {
  expression: string;
  error: string;
}

export interface ResolvedBindings<T> {
  value: T;
  unresolved: UnresolvedBinding[];
}

/**
 * Walk a JSON value, evaluating every `${{ }}` expression in every string.
 * A string that is exactly one expression resolves to the raw evaluated
 * value (any JSON type); embedded expressions interpolate as strings.
 * Expressions that fail to evaluate are left in place and reported.
 */
export function resolveBindings<T>(
  value: T,
  evaluate: (expression: string) => unknown,
): ResolvedBindings<T> {
  const unresolved: UnresolvedBinding[] = [];

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      return resolveString(node);
    }
    if (Array.isArray(node)) {
      return node.map(walk);
    }
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  };

  const resolveString = (text: string): unknown => {
    const matches = [...text.matchAll(EXPRESSION_PATTERN)];
    if (matches.length === 0) return text;

    // Whole-string single expression: return the raw evaluated value.
    const only = matches[0];
    if (matches.length === 1 && only[0] === text.trim()) {
      try {
        return evaluate(only[1].trim());
      } catch (error) {
        unresolved.push({
          expression: only[1].trim(),
          error: error instanceof Error ? error.message : String(error),
        });
        return text;
      }
    }

    // Embedded expressions: interpolate.
    return text.replaceAll(EXPRESSION_PATTERN, (whole, expr: string) => {
      try {
        const result = evaluate(expr.trim());
        if (result === null || result === undefined) return "";
        return typeof result === "string" ? result : JSON.stringify(result);
      } catch (error) {
        unresolved.push({
          expression: expr.trim(),
          error: error instanceof Error ? error.message : String(error),
        });
        return whole;
      }
    });
  };

  return { value: walk(value) as T, unresolved };
}
