/**
 * Types for dbt artifact schemas — manifest.json, catalog.json, run_results.json.
 * These describe the raw dbt output before Docglow transforms it.
 */

// -- Column lineage ----------------------------------------------------------

export interface ColumnLineageDependency {
  readonly source_model: string;
  readonly source_column: string;
  readonly transformation: "passthrough" | "rename" | "aggregated" | "derived" | "unknown" | "direct";
}

export interface ColumnDownstreamDependency {
  readonly target_model: string;
  readonly target_column: string;
  readonly transformation: "passthrough" | "rename" | "aggregated" | "derived" | "unknown" | "direct";
}

export type ColumnLineageData = Record<
  string,
  Record<string, ColumnLineageDependency[]>
>;

/** Join ON/USING key pair resolved to dbt unique_ids (keyed under join_keys[model]). */
export interface JoinKeyPair {
  readonly left_model: string;
  readonly left_column: string;
  readonly right_model: string;
  readonly right_column: string;
  readonly join_type?: string;
}

export type JoinKeysData = Record<string, JoinKeyPair[]>;

/**
 * Map of model unique_id → the FROM (foundation) parent unique_id of that
 * model's primary JOIN block. Omitted when column lineage is skipped or the
 * model has no JOINs.
 */
export type JoinBasesData = Record<string, string>;

/** Parent reached only via a non-passthrough CTE that is JOINed. */
export interface JoinIndirectParent {
  readonly model: string;
  /** ``agg`` when the CTE aggregates; otherwise ``cte``. */
  readonly kind: "agg" | "cte" | string;
}

/**
 * Map of model unique_id → parents that contribute through intermediate CTEs
 * rather than as the FROM base or a direct JOIN endpoint.
 */
export type JoinIndirectData = Record<string, JoinIndirectParent[]>;

/** Join keys attached to a table-level lineage edge (source → target). */
export interface LineageEdgeJoinKey {
  readonly source_column: string;
  readonly target_column: string;
}

export interface ColumnEdge {
  readonly sourceModel: string;
  readonly sourceColumn: string;
  readonly targetModel: string;
  readonly targetColumn: string;
  readonly transformation: "passthrough" | "rename" | "aggregated" | "derived" | "unknown" | "direct";
}

// -- Artifact version metadata -----------------------------------------------

export interface ArtifactVersions {
  readonly manifest: string;
  readonly catalog: string | null;
  readonly run_results: string | null;
  readonly sources: string | null;
}
