/**
 * Types for dbt artifact schemas — manifest.json, catalog.json, run_results.json.
 * These describe the raw dbt output before Docglow transforms it.
 */

// -- Column lineage ----------------------------------------------------------

/** Column transformation vocabulary (analysis + display). */
export type TransformationType =
  | "passthrough"
  | "rename"
  | "aggregated"
  | "derived"
  | "constant"
  | "untraced"
  | "unknown"
  | "direct";

/**
 * Strongest-kind order for display / merge (low → high).
 * Keep in sync with ``_PRIORITY`` in ``docglow.lineage.column_parser``.
 */
export const TRANSFORMATION_STRENGTH: readonly TransformationType[] = [
  "unknown",
  "untraced",
  "direct",
  "passthrough",
  "rename",
  "constant",
  "derived",
  "aggregated",
] as const;

export interface ColumnLineageDependency {
  readonly source_model?: string;
  readonly source_column?: string;
  readonly transformation: TransformationType;
  /** Defining SQL for derived/aggregated/constant columns (alias stripped). */
  readonly expression?: string;
}

export interface ColumnDownstreamDependency {
  readonly target_model: string;
  readonly target_column: string;
  readonly transformation: TransformationType;
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

/**
 * @deprecated Join keys are canonical on DocglowData.join_keys only.
 * Kept optional on edges for older generated sites.
 */
export interface LineageEdgeJoinKey {
  readonly source_column: string;
  readonly target_column: string;
}

export interface ColumnEdge {
  readonly sourceModel: string;
  readonly sourceColumn: string;
  readonly targetModel: string;
  readonly targetColumn: string;
  readonly transformation: TransformationType;
  readonly expression?: string;
}

// -- Artifact version metadata -----------------------------------------------

export interface ArtifactVersions {
  readonly manifest: string;
  readonly catalog: string | null;
  readonly run_results: string | null;
  readonly sources: string | null;
}
