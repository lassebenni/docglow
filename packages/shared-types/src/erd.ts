/**
 * Types for Docglow ERD (entity-relationship) view — relationship rows and
 * per-model partner summaries.
 *
 * Wire-shape mirror of the Python `ErdRelationship` and `RelationshipSummary`
 * TypedDicts in `src/docglow/generator/data.py`. Field names are snake_case
 * to match the JSON payload exactly — no casing conversion happens at the
 * frontend boundary. When `enable_erd` is False on the Python side, the
 * `relationships` payload key and per-model `relationships_count` /
 * `relationships_summary` keys are omitted entirely (not just empty), so
 * consumers should treat these fields as optional.
 */

export type ErdKind = "one_to_one" | "one_to_many" | "many_to_many" | "inferred";

export type ErdEndpoint =
  | "one_and_only_one"
  | "zero_or_one"
  | "one_or_many"
  | "zero_or_many";

export type ErdInferenceSource = "test" | "meta" | "both";

export type ErdSeverity = "error" | "warn" | "info";

export type ErdStatus = "pass" | "fail" | "warn" | "not_run" | "none";

/**
 * One ERD relationship row in `docglow-data.json` (top-level `relationships`).
 *
 * Mirrors the Python `ErdRelationship` TypedDict in
 * `src/docglow/generator/data.py` field-for-field (17 fields). Produced by
 * `docglow.generator.erd._compose` from dbt `relationships` tests and
 * `meta.docglow.relationships` declarations.
 */
export interface ErdRelationship {
  readonly id: string;
  readonly from_unique_id: string;
  readonly from_column: string;
  /**
   * Empty string is the ghost-edge sentinel — used when a meta-declared
   * relationship references a parent that could not be resolved to a dbt
   * unique_id. Consumers should treat empty `to_unique_id` as "unresolved
   * partner" and avoid linking to a non-existent model page.
   */
  readonly to_unique_id: string;
  readonly to_column: string;
  readonly to_model_name: string;
  readonly kind: ErdKind;
  readonly child_endpoint: ErdEndpoint;
  readonly parent_endpoint: ErdEndpoint;
  readonly inference_source: ErdInferenceSource;
  readonly severity: ErdSeverity;
  readonly status: ErdStatus;
  readonly label: string | null;
  readonly test_unique_id: string | null;
  readonly meta_file_path: string | null;
  readonly is_synthetic: boolean;
  readonly parent_column_exists: boolean;
}

/**
 * Per-model summary entry: a single partner model + the count of edges
 * connecting the two. Populated as a top-N (capped at 3, sorted by
 * `edge_count` desc with `partner_unique_id` ascending as tiebreak) on
 * each model's `relationships_summary` field.
 *
 * Mirrors the Python `RelationshipSummary` TypedDict in
 * `src/docglow/generator/data.py`.
 */
export interface RelationshipSummary {
  readonly partner_unique_id: string;
  readonly edge_count: number;
}
