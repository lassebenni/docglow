/**
 * Types for Docglow's transformed model/source/exposure/metric data.
 * These are the shapes that appear in docglow-data.json and are consumed
 * by both the OSS frontend and the cloud dashboard.
 */

import type { RelationshipSummary } from "./erd.js";

// -- Columns -----------------------------------------------------------------

export interface ColumnInsights {
  readonly role: string | null;
  readonly semantic_type: string | null;
  readonly sql_usage: string[];
  readonly confidence: number;
  readonly generated_description: string | null;
}

export interface DocglowColumn {
  readonly name: string;
  readonly description: string;
  readonly data_type: string;
  readonly meta: Record<string, unknown>;
  readonly tags: string[];
  readonly tests: ColumnTest[];
  readonly profile: ColumnProfile | null;
  readonly insights?: ColumnInsights | null;
}

export interface ColumnTest {
  readonly test_name: string;
  readonly test_type: string;
  readonly status: "pass" | "fail" | "warn" | "error" | "not_run";
  readonly config: Record<string, unknown>;
}

export interface ColumnProfile {
  readonly row_count: number;
  readonly null_count: number;
  readonly null_rate: number;
  readonly distinct_count: number;
  readonly distinct_rate: number;
  readonly is_unique: boolean;
  readonly min?: string | number | null;
  readonly max?: string | number | null;
  readonly mean?: number | null;
  readonly median?: number | null;
  readonly stddev?: number | null;
  readonly min_length?: number | null;
  readonly max_length?: number | null;
  readonly avg_length?: number | null;
  readonly top_values?: TopValue[] | null;
  readonly histogram?: HistogramBin[] | null;
  readonly temporal_distribution?: TemporalBin[] | null;
}

export interface TemporalBin {
  readonly date: string;
  readonly count: number;
}

export interface TopValue {
  readonly value: string;
  readonly frequency: number;
}

export interface HistogramBin {
  readonly low: number;
  readonly high: number;
  readonly count: number;
}

// -- Test results ------------------------------------------------------------

export interface TestResult {
  readonly test_name: string;
  readonly test_unique_id: string;
  readonly test_type: string;
  readonly column_name: string | null;
  readonly status: "pass" | "fail" | "warn" | "error" | "not_run";
  readonly execution_time: number;
  readonly failures: number;
  readonly message: string | null;
  /** Compiled SQL from run_results or manifest (warehouse-ready). */
  readonly compiled_sql?: string | null;
  /** Raw Jinja SQL from the test node when compiled SQL is unavailable. */
  readonly raw_sql?: string | null;
}

export interface LastRun {
  readonly status: string | null;
  readonly execution_time: number | null;
  readonly completed_at: string | null;
}

export interface CatalogStats {
  readonly row_count: number | null;
  readonly bytes: number | null;
  readonly has_stats: boolean;
}

/** Model-level profiling metadata attached when column profiling is enabled. */
export interface ProfilingMeta {
  /** Full table row count from catalog stats or a warehouse COUNT(*) query. */
  readonly total_row_count: number;
  /** Rows actually scanned for column statistics (may be a sample). */
  readonly profiled_row_count: number;
  /** Configured sample limit, when sampling was requested. */
  readonly sample_size: number | null;
  /** True when column stats were computed on fewer rows than the full table. */
  readonly is_sampled: boolean;
}

// -- Models ------------------------------------------------------------------

export interface DocglowModel {
  readonly unique_id: string;
  readonly name: string;
  readonly description: string;
  readonly schema: string;
  /**
   * Database/catalog name. Empty string (`''`) when the dbt adapter does not
   * populate it (e.g. dbt-glue, dbt-spark, dbt-athena). Consumers must handle
   * the empty case — do not concatenate `database.schema` unconditionally.
   * Use `formatFqn` from `frontend/src/utils/formatting.ts` for display.
   */
  readonly database: string;
  readonly materialization: string;
  readonly tags: string[];
  readonly meta: Record<string, unknown>;
  readonly path: string;
  readonly folder: string;
  readonly raw_sql: string;
  readonly compiled_sql: string;
  readonly columns: DocglowColumn[];
  readonly depends_on: string[];
  readonly referenced_by: string[];
  readonly sources_used: string[];
  readonly test_results: TestResult[];
  readonly last_run: LastRun | null;
  readonly catalog_stats: CatalogStats;
  /**
   * Total number of ERD relationships (bidirectional: incoming + outgoing FKs)
   * connecting this model to other models. Omitted entirely when ERD
   * inference is disabled (`--enable-erd` flag not passed).
   */
  readonly relationships_count?: number;
  /**
   * Top partners by edge count (capped at 3, sorted by `edge_count` desc
   * with `partner_unique_id` ascending as tiebreak). Omitted entirely
   * when ERD inference is disabled.
   */
  readonly relationships_summary?: RelationshipSummary[];
  /**
   * Structured sample of warehouse rows for this model. Attached at
   * site-generation time when `--sample-data-dir` contains a matching
   * `<model_name>.json` file. Omitted entirely when no file exists.
   *
   * Rendered by the frontend as an interactive "Data" tab with sortable
   * headers, substring search, and a horizontal-scroll container.
   */
  readonly sample_data?: SampleData;
  /**
   * Static HTML concept docs for this model. Attached at site-generation time
   * from ``meta.docglow.docs`` and/or convention files under ``docs_dir``.
   * Each entry is rendered as a tab with an iframe pointing at the copied
   * HTML asset in the generated site.
   */
  readonly custom_docs?: readonly CustomDoc[];
  /**
   * Profiling metadata for the Statistics tab. Present when column profiling
   * was run during site generation.
   */
  readonly profiling?: ProfilingMeta;
  /**
   * Business Q&A entries for the Questions tab. Attached at site-generation
   * time from ``meta.docglow.questions``. Omitted when the model declares
   * no questions.
   */
  readonly questions?: readonly ModelQuestion[];
}

/** Latest dbt test result bound to a documented question via ``verified_by``. */
export interface QuestionVerification {
  readonly test_name: string;
  readonly test_unique_id: string;
  readonly test_type: string;
  readonly status: "pass" | "fail" | "warn" | "error" | "not_run" | "misconfigured";
  readonly failures: number;
  readonly message: string | null;
  readonly execution_time: number;
  /** ISO timestamp from run_results.metadata.generated_at when available. */
  readonly verified_at: string | null;
  /** Compiled SQL from run_results or manifest (warehouse-ready). */
  readonly compiled_sql?: string | null;
  /** Raw Jinja SQL from the test node when compiled SQL is unavailable. */
  readonly raw_sql?: string | null;
}

/** A business question the model answers, authored in ``meta.docglow.questions``. */
export interface ModelQuestion {
  /** The business question, plain prose. */
  readonly question: string;
  /** One-clause answer; may contain inline markdown (e.g. backticked column names). */
  readonly answer: string;
  /**
   * Optional proof reference: "<custom-doc slug>#<anchor>" pointing at a
   * custom_docs tab (e.g. "workbook#cte-sku_bridge"), or "self#<anchor>"
   * for an anchor within the model's own guide doc.
   */
  readonly proof?: string;
  /**
   * Optional name of a dbt test that re-verifies this answer on every build.
   * Site generation attaches a ``verification`` block with the latest result.
   */
  readonly verified_by?: string;
  /** Populated at site-generation time when ``verified_by`` is set. */
  readonly verification?: QuestionVerification;
}

/** A static HTML document tab attached to a model at generate time. */
export interface CustomDoc {
  /** URL-safe tab slug used in /model/:id/:slug routes. */
  readonly slug: string;
  /** Human-readable tab label. */
  readonly label: string;
  /** Site-relative path to the copied HTML file (e.g. docs/my_model/concept.html). */
  readonly url: string;
  /** Project-relative source path at generate time (e.g. analyses/foo/workbook.html). */
  readonly source_file?: string;
}

/** Pre-dumped warehouse sample attached to a model at site-generation time. */
export interface SampleData {
  readonly schema: string;
  readonly table: string;
  /** Columns actually sampled (non-PII). Each row aligns 1:1 with this list. */
  readonly columns: readonly string[];
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>;
  readonly row_count: number;
  readonly limit: number;
  /** ISO-8601 UTC timestamp from the dump tool. */
  readonly generated_at: string;
  /**
   * Full warehouse column list in ordinal order, including withheld PII columns.
   * When present, the Data tab renders every column; withheld ones show a
   * redacted placeholder instead of live values.
   */
  readonly all_columns?: readonly string[];
  /**
   * Columns the dump tool refused to sample, surfaced so reviewers can see
   * what was withheld. Two buckets:
   * - `pii_meta`: dbt YAML carried `meta.pii: true` on the column.
   * - `name_flagged`: the column name matched a built-in PII heuristic
   *   (email, phone, iban, bsn, dob, …).
   */
  readonly excluded_columns?: {
    readonly pii_meta: readonly string[];
    readonly name_flagged: readonly string[];
  };
}

// -- Sources -----------------------------------------------------------------

export interface DocglowSource {
  readonly unique_id: string;
  readonly name: string;
  readonly source_name: string;
  readonly description: string;
  readonly schema: string;
  /**
   * Database/catalog name. Empty string (`''`) when the dbt adapter does not
   * populate it (e.g. dbt-glue, dbt-spark, dbt-athena). Consumers must handle
   * the empty case — do not concatenate `database.schema` unconditionally.
   * Use `formatFqn` from `frontend/src/utils/formatting.ts` for display.
   */
  readonly database: string;
  readonly columns: DocglowColumn[];
  readonly tags: string[];
  readonly meta: Record<string, unknown>;
  readonly loader: string;
  readonly loaded_at_field: string | null;
  readonly freshness_status: string | null;
  readonly freshness_max_loaded_at: string | null;
  readonly freshness_snapshotted_at: string | null;
}

// -- Exposures & Metrics -----------------------------------------------------

export interface DocglowExposure {
  readonly unique_id: string;
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly depends_on: string[];
  readonly owner: Record<string, string>;
  readonly tags: string[];
}

export interface DocglowMetric {
  readonly unique_id: string;
  readonly name: string;
  readonly description: string;
  readonly label: string;
  readonly type: string;
  readonly depends_on: string[];
  readonly tags: string[];
}

/** Union type for any resource that can be displayed. */
export type DocglowResource = DocglowModel | DocglowSource;
