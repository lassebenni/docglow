/**
 * ErdInspector — the right rail on the ERD page.
 *
 * Three render branches per origin requirements §5.7:
 *   1. **Empty** (no edge / no node selected): a hint + YAML snippet showing
 *      how to add a `relationships` test.
 *   2. **Edge selected**: tightened relationship inspector — eyebrow row
 *      with severity + status badges, identifier headline with arrow,
 *      narrative paragraph, 2-col bordered metadata grid, code excerpt.
 *      Three text styles total (caps label, body sans, mono identifiers)
 *      per the design system. No italic, no drop-cap, no amber accent
 *      (amber is reserved for the active node ring in the diagram).
 *   3. **Node selected (no edge)**: U2 fills this in. Stub for now.
 *
 * The YAML excerpt synthesis is extracted to a pure helper
 * (`synthesizeRelationshipYaml`) so it can be unit-tested without DOM.
 */

import { useNavigate } from 'react-router-dom'
import type {
  DocglowModel,
  ErdInferenceSource,
  ErdRelationship,
  ErdSeverity,
  ErdStatus,
} from '../../types'
import { getResourceUrl } from '../../utils/erdResourceUrl'

export interface ErdInspectorProps {
  readonly models: Readonly<Record<string, DocglowModel>>
  readonly relationships: readonly ErdRelationship[]
  readonly selectedEdgeId: string | null
  readonly selectedNodeId: string | null
  /**
   * Called from the node-branch relationship list to re-route to the edge
   * inspector. Wired by `ErdCanvas` to a setter that also clears the node
   * selection (mutual exclusion — see DOC-216 U2).
   */
  readonly onSelectEdge?: (id: string) => void
}

/* ------------------------------------------------------------------ */
/* Pure helpers (logic-tested in __tests__/erdInspector.test.ts).      */
/* ------------------------------------------------------------------ */

/**
 * Build the YAML excerpt for the inspector code block.
 *
 * - `test` or `both` → render a `relationships` test snippet (test wins per
 *   §5.4 composition rules; if `both`, the test still drives the edge color).
 * - `meta` only      → render a `meta.docglow.relationships` snippet.
 */
export function synthesizeRelationshipYaml(args: {
  readonly inferenceSource: ErdInferenceSource
  readonly fromColumn: string
  readonly toColumn: string
  readonly toModelName: string
  readonly toUniqueId: string
}): string {
  if (args.inferenceSource === 'meta') {
    return [
      'meta:',
      '  docglow:',
      '    relationships:',
      `      - to: ${args.toUniqueId}`,
      `        from_column: ${args.fromColumn}`,
      `        to_column: ${args.toColumn}`,
    ].join('\n')
  }
  return [
    '- relationships:',
    `    to: ref('${args.toModelName}')`,
    `    field: ${args.toColumn}`,
  ].join('\n')
}

/**
 * Lookup a model by `unique_id`. Falls back to the trailing segment of the
 * id when the model is missing from the payload (edge case 6 / 8 — the
 * relationship still renders but the parent doesn't exist).
 */
export function resolveModelName(
  uniqueId: string,
  models: Readonly<Record<string, DocglowModel>>,
): string {
  const model = models[uniqueId]
  if (model) return model.name
  return uniqueId.split('.').pop() ?? uniqueId
}

/** Basename of a dbt unique_id (e.g. `test.proj.relationships_orders_customer_id` → trailing seg). */
export function basenameUniqueId(uniqueId: string | null): string | null {
  if (!uniqueId) return null
  const parts = uniqueId.split('.')
  return parts[parts.length - 1] ?? uniqueId
}

/**
 * Partition a relationships list into the outgoing (`from_unique_id ===
 * uid`) and incoming (`to_unique_id === uid`) buckets for a given node.
 *
 * Self-referential relationships (`from_unique_id === to_unique_id ===
 * uid`) appear in **both** buckets, since the node both references and is
 * referenced by itself — this matches the user's mental model when
 * scanning §5.7's "references / referenced by" lists.
 *
 * Order is preserved from the input array in each bucket — callers
 * typically pass `relationships` from `DocglowData` which is already
 * sorted by the backend.
 */
export function partitionRelationshipsForNode(
  uniqueId: string,
  relationships: readonly ErdRelationship[],
): {
  readonly outgoing: readonly ErdRelationship[]
  readonly incoming: readonly ErdRelationship[]
} {
  const outgoing: ErdRelationship[] = []
  const incoming: ErdRelationship[] = []
  for (const rel of relationships) {
    if (rel.from_unique_id === uniqueId) outgoing.push(rel)
    if (rel.to_unique_id === uniqueId) incoming.push(rel)
  }
  return { outgoing, incoming }
}

/* ------------------------------------------------------------------ */
/* Subcomponents.                                                      */
/* ------------------------------------------------------------------ */

const SEVERITY_TONE: Record<ErdSeverity, 'danger' | 'warning' | 'info'> = {
  error: 'danger',
  warn: 'warning',
  info: 'info',
}

const STATUS_TONE: Record<ErdStatus, 'success' | 'danger' | 'warning' | 'muted'> = {
  pass: 'success',
  fail: 'danger',
  warn: 'warning',
  not_run: 'muted',
  none: 'muted',
}

const STATUS_LABEL: Record<ErdStatus, string> = {
  pass: 'passing',
  fail: 'failing',
  warn: 'warning',
  not_run: 'not run',
  none: '—',
}

/** Soft-tinted badge using design-system color tokens. */
function SoftBadge({
  tone,
  children,
}: {
  readonly tone: 'success' | 'danger' | 'warning' | 'info' | 'muted'
  readonly children: React.ReactNode
}) {
  if (tone === 'muted') {
    return (
      <span
        className="inline-block px-2 py-0.5 text-xs font-medium rounded capitalize"
        style={{
          background: 'var(--bg-surface)',
          color: 'var(--text-muted)',
          border: '1px solid var(--border)',
        }}
      >
        {children}
      </span>
    )
  }
  return (
    <span
      className="inline-block px-2 py-0.5 text-xs font-medium rounded capitalize"
      style={{
        background: `color-mix(in oklab, var(--color-${tone}) 10%, transparent)`,
        color: `var(--color-${tone})`,
      }}
    >
      {children}
    </span>
  )
}

/**
 * Small icon-button that navigates to a resource detail page.
 *
 * Used in two places:
 *   1. Edge inspector headline — one per qualifier (from / to). Sits
 *      visually adjacent to the qualifier text as a compact arrow icon.
 *   2. Node inspector — a single text+icon link below the headline.
 *
 * `variant` swaps between the two visual treatments. The click handler
 * delegates URL construction to `getResourceUrl` (pure helper).
 */
function OpenResourceButton({
  uniqueId,
  label,
  variant,
  onNavigate,
}: {
  readonly uniqueId: string
  readonly label: string
  readonly variant: 'icon' | 'link'
  readonly onNavigate: (url: string) => void
}) {
  const handleClick = () => onNavigate(getResourceUrl(uniqueId))
  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={handleClick}
        aria-label={label}
        title={label}
        className="inline-flex items-center justify-center align-middle rounded transition-colors"
        style={{
          width: 16,
          height: 16,
          marginLeft: 2,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          padding: 0,
          verticalAlign: 'baseline',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--text)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--text-muted)'
        }}
        data-erd-open-uid={uniqueId}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 3h7v7" />
          <path d="M13 3 6.5 9.5" />
          <path d="M11 9v4H3V5h4" />
        </svg>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 text-xs"
      style={{
        background: 'transparent',
        border: 'none',
        color: '#2563eb',
        cursor: 'pointer',
        padding: 0,
        fontFamily:
          'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
        fontSize: 11,
        letterSpacing: '0.04em',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = 'underline'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = 'none'
      }}
      data-erd-open-uid={uniqueId}
    >
      <span>{label}</span>
      <span aria-hidden="true">→</span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Render branches.                                                    */
/* ------------------------------------------------------------------ */

function EmptyInspector() {
  const yamlSnippet = [
    'columns:',
    '  - name: customer_id',
    '    tests:',
    '      - relationships:',
    "          to: ref('customers')",
    '          field: customer_id',
  ].join('\n')

  return (
    <div className="px-5 pt-6 pb-5 flex flex-col gap-3">
      <div
        className="text-xs"
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        inspector
      </div>
      <div
        className="text-sm font-medium leading-snug"
        style={{ color: 'var(--text)' }}
      >
        Select an edge to see relationship details.
      </div>
      <p
        className="text-xs leading-relaxed"
        style={{ color: 'var(--text-muted)' }}
      >
        Click any crow&apos;s-foot edge on the canvas to read its inferred
        cardinality, contributing tests, and YAML excerpt. Don&apos;t see any
        edges? Add a <code>relationships</code> test to a column:
      </p>
      <pre
        className="px-3 py-2 text-xs rounded border whitespace-pre overflow-x-auto"
        style={{
          background: 'var(--bg-surface)',
          borderColor: 'var(--border)',
          color: 'var(--text)',
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          lineHeight: 1.5,
        }}
        data-testid="erd-inspector-empty-yaml"
      >
        {yamlSnippet}
      </pre>
    </div>
  )
}

/** Status → dot color (mirrors edge inspector's STATUS_TONE → CSS var). */
const STATUS_DOT_COLOR: Record<ErdStatus, string> = {
  pass: 'var(--color-success)',
  fail: 'var(--color-danger)',
  warn: 'var(--color-warning)',
  not_run: 'var(--text-muted)',
  none: 'var(--text-muted)',
}

interface NodeInspectorProps {
  readonly model: DocglowModel | null
  readonly nodeId: string
  readonly outgoing: readonly ErdRelationship[]
  readonly incoming: readonly ErdRelationship[]
  readonly models: Readonly<Record<string, DocglowModel>>
  readonly onSelectEdge?: (id: string) => void
  readonly onOpenResource: (url: string) => void
}

interface RelationshipRowProps {
  readonly rel: ErdRelationship
  readonly leftLabel: string
  readonly rightLabel: string
  readonly onSelectEdge?: (id: string) => void
}

function RelationshipRow({
  rel,
  leftLabel,
  rightLabel,
  onSelectEdge,
}: RelationshipRowProps) {
  const handleClick = () => onSelectEdge?.(rel.id)
  return (
    <li>
      <button
        type="button"
        onClick={handleClick}
        className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded transition-colors"
        style={{
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 12,
          color: 'var(--text)',
          background: 'transparent',
          border: '1px solid transparent',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--bg-surface)'
          e.currentTarget.style.borderColor = 'var(--border)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.borderColor = 'transparent'
        }}
        data-erd-rel-id={rel.id}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: STATUS_DOT_COLOR[rel.status],
            flexShrink: 0,
          }}
        />
        <span className="truncate" style={{ flex: 1, minWidth: 0 }}>
          <span>{leftLabel}</span>
          <span style={{ color: 'var(--text-muted)' }}> → </span>
          <span>{rightLabel}</span>
        </span>
      </button>
    </li>
  )
}

function NodeInspector({
  model,
  nodeId,
  outgoing,
  incoming,
  models,
  onSelectEdge,
  onOpenResource,
}: NodeInspectorProps) {
  const modelName = model ? model.name : (basenameUniqueId(nodeId) ?? nodeId)
  const totalRels = outgoing.length + incoming.length
  const sectionLabelStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom: 6,
  }
  const emptySublineStyle: React.CSSProperties = {
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
    fontSize: 12,
    paddingLeft: 8,
  }

  return (
    <div className="flex flex-col" data-testid="erd-inspector-node">
      {/* Dateline */}
      <div
        className="px-5 pt-6 pb-2 flex items-center gap-2"
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        <span>node</span>
      </div>

      {/* Headline */}
      <h2
        className="px-5 pb-3 leading-tight flex items-center gap-2"
        style={{
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          color: 'var(--text)',
        }}
        data-testid="erd-inspector-node-headline"
      >
        <span
          className="inline-flex items-center justify-center rounded font-bold shrink-0"
          aria-label="model"
          style={{
            background: '#2563eb',
            color: 'white',
            width: 16,
            height: 16,
            fontSize: 10,
          }}
        >
          M
        </span>
        <span
          style={{
            fontFamily:
              'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            fontSize: 15,
            color: 'var(--text)',
          }}
        >
          {modelName}
        </span>
      </h2>

      {/* Subhead — relationship count */}
      <div
        className="px-5 pb-2"
        style={{
          color: 'var(--text-muted)',
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 11,
        }}
      >
        {totalRels} {totalRels === 1 ? 'relationship' : 'relationships'}
      </div>

      {/* Open-model link (DOC-220 / U4) */}
      <div className="px-5 pb-4" data-testid="erd-inspector-node-open">
        <OpenResourceButton
          uniqueId={nodeId}
          label="Open model details"
          variant="link"
          onNavigate={onOpenResource}
        />
      </div>

      {/* Both groups empty — show a muted note. */}
      {totalRels === 0 && (
        <div
          className="px-5 pb-5 text-sm"
          style={{ color: 'var(--text-muted)', lineHeight: 1.55 }}
          data-testid="erd-inspector-node-empty"
        >
          This model has no relationships.
        </div>
      )}

      {/* References (outgoing) */}
      {totalRels > 0 && (
        <section
          className="px-5 pb-4"
          data-testid="erd-inspector-node-references"
        >
          <div style={sectionLabelStyle}>references</div>
          {outgoing.length === 0 ? (
            <div style={emptySublineStyle}>(none)</div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {outgoing.map((rel) => {
                const toName =
                  rel.to_model_name ||
                  resolveModelName(rel.to_unique_id, models)
                return (
                  <RelationshipRow
                    key={rel.id}
                    rel={rel}
                    leftLabel={rel.from_column}
                    rightLabel={`${toName}.${rel.to_column}`}
                    onSelectEdge={onSelectEdge}
                  />
                )
              })}
            </ul>
          )}
        </section>
      )}

      {/* Referenced by (incoming) */}
      {totalRels > 0 && (
        <section
          className="px-5 pb-4"
          data-testid="erd-inspector-node-referenced-by"
        >
          <div style={sectionLabelStyle}>referenced by</div>
          {incoming.length === 0 ? (
            <div style={emptySublineStyle}>(none)</div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {incoming.map((rel) => {
                const fromName = resolveModelName(rel.from_unique_id, models)
                return (
                  <RelationshipRow
                    key={rel.id}
                    rel={rel}
                    leftLabel={`${fromName}.${rel.from_column}`}
                    rightLabel={rel.to_column}
                    onSelectEdge={onSelectEdge}
                  />
                )
              })}
            </ul>
          )}
        </section>
      )}

      {/* Footer */}
      <div
        className="px-5 py-3 mt-auto flex items-center gap-2"
        style={{
          borderTop: '1px solid var(--border)',
          color: 'var(--text-muted)',
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 11,
          letterSpacing: '0.04em',
        }}
      >
        <span>relationships: {totalRels}</span>
      </div>
    </div>
  )
}

interface EdgeInspectorProps {
  readonly relationship: ErdRelationship
  readonly fromModelName: string
  readonly toModelName: string
  readonly onOpenResource: (url: string) => void
}

function EdgeInspector({
  relationship,
  fromModelName,
  toModelName,
  onOpenResource,
}: EdgeInspectorProps) {
  const fromQualified = `${fromModelName}.${relationship.from_column}`
  const toQualified = `${toModelName}.${relationship.to_column}`

  const testBasename = basenameUniqueId(relationship.test_unique_id)
  const inferenceLabel: Record<ErdInferenceSource, string> = {
    test: 'test',
    meta: 'meta',
    both: 'both',
  }

  const yamlExcerpt = synthesizeRelationshipYaml({
    inferenceSource: relationship.inference_source,
    fromColumn: relationship.from_column,
    toColumn: relationship.to_column,
    toModelName,
    toUniqueId: relationship.to_unique_id,
  })

  // 2-col grid metadata (Test, Inference, File, Type). Cardinality (kind) is
  // the most informative 4th cell — distinct from the test-source dimension
  // already covered by Inference.
  const metaCells: ReadonlyArray<readonly [string, React.ReactNode]> = [
    [
      'Test',
      <code className="font-mono text-xs" style={{ color: 'var(--text)' }}>
        {testBasename ?? '—'}
      </code>,
    ],
    [
      'Inference',
      <code className="font-mono text-xs" style={{ color: 'var(--text)' }}>
        {inferenceLabel[relationship.inference_source]}
      </code>,
    ],
    [
      'File',
      relationship.meta_file_path ? (
        <code className="font-mono text-xs" style={{ color: 'var(--text)' }}>
          {relationship.meta_file_path}
        </code>
      ) : (
        <span style={{ color: 'var(--text-muted)' }}>—</span>
      ),
    ],
    [
      'Type',
      <code className="font-mono text-xs" style={{ color: 'var(--text)' }}>
        {relationship.kind}
      </code>,
    ],
  ]

  return (
    <div className="flex flex-col">
      {/* Eyebrow row: kind label + Severity + Status badges */}
      <div className="px-5 pt-6 pb-2.5 flex items-center gap-2 flex-wrap">
        <span
          className="text-[11px] font-semibold tracking-[0.1em] uppercase"
          style={{ color: 'var(--text-muted)' }}
        >
          Relationship
        </span>
        <span style={{ color: 'var(--text-muted)', opacity: 0.5 }}>·</span>
        <SoftBadge tone={SEVERITY_TONE[relationship.severity]}>
          {relationship.severity}
        </SoftBadge>
        <SoftBadge tone={STATUS_TONE[relationship.status]}>
          {STATUS_LABEL[relationship.status]}
        </SoftBadge>
      </div>

      {/* Headline: identifiers + arrow, body-medium weight (mono carries weight). */}
      <div
        className="px-5 pb-4 text-sm font-medium leading-snug"
        style={{ color: 'var(--text)' }}
        data-testid="erd-inspector-headline"
      >
        <span className="font-mono">{fromQualified}</span>
        <OpenResourceButton
          uniqueId={relationship.from_unique_id}
          label={`Open ${fromModelName}`}
          variant="icon"
          onNavigate={onOpenResource}
        />
        <span
          className="mx-1.5 font-normal"
          style={{ color: 'var(--text-muted)' }}
        >
          →
        </span>
        <span className="font-mono">{toQualified}</span>
        <OpenResourceButton
          uniqueId={relationship.to_unique_id}
          label={`Open ${toModelName}`}
          variant="icon"
          onNavigate={onOpenResource}
        />
      </div>

      {/* Body paragraph — plain prose, no drop-cap, no italic. */}
      <div
        className="px-5 pb-4 text-sm"
        style={{
          color: 'var(--text)',
          lineHeight: 1.55,
        }}
      >
        <p>
          Every row of{' '}
          <code className="font-mono text-xs" style={{ color: 'var(--text)' }}>
            {fromModelName}
          </code>{' '}
          must point at a real{' '}
          <code className="font-mono text-xs" style={{ color: 'var(--text)' }}>
            {toModelName}
          </code>
          .{' '}
          {relationship.inference_source === 'meta' ? (
            <>
              This relationship is declared via{' '}
              <code
                className="font-mono text-xs"
                style={{ color: 'var(--text)' }}
              >
                meta.docglow.relationships
              </code>
              {' '}— Docglow surfaces it without a build-time check.
            </>
          ) : (
            <>
              The{' '}
              <code
                className="font-mono text-xs"
                style={{ color: 'var(--text)' }}
              >
                {testBasename ?? 'relationships'}
              </code>{' '}
              test guards this on every{' '}
              <code
                className="font-mono text-xs"
                style={{ color: 'var(--text)' }}
              >
                dbt build
              </code>
              {' '}— orphans surface as build failures rather than silent data
              drift.
            </>
          )}
        </p>
      </div>

      {/* 2-col bordered meta grid */}
      <div
        className="mx-5 mb-4 grid grid-cols-2 rounded-md overflow-hidden"
        style={{ border: '1px solid var(--border)' }}
        data-testid="erd-inspector-meta"
      >
        {metaCells.map(([label, val], i) => {
          const isLeftCol = i % 2 === 0
          const isInTopRow = i < metaCells.length - 2
          return (
            <div
              key={label}
              className="px-2.5 py-2"
              style={{
                borderRight: isLeftCol ? '1px solid var(--border)' : undefined,
                borderBottom: isInTopRow ? '1px solid var(--border)' : undefined,
              }}
            >
              <div
                className="text-[11px] font-medium mb-1"
                style={{ color: 'var(--text-muted)' }}
              >
                {label}
              </div>
              <div className="text-[13px]" style={{ color: 'var(--text)' }}>
                {val}
              </div>
            </div>
          )
        })}
      </div>

      {/* Excerpt */}
      <div className="px-5 pb-5">
        <div
          className="text-xs font-medium mb-1.5"
          style={{ color: 'var(--text-muted)' }}
        >
          Excerpt
        </div>
        <pre
          className="px-3 py-2 rounded-md whitespace-pre overflow-x-auto font-mono text-xs"
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            color: 'var(--text)',
            lineHeight: 1.5,
          }}
          data-testid="erd-inspector-yaml"
        >
          {yamlExcerpt}
        </pre>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Top-level component.                                                */
/* ------------------------------------------------------------------ */

export function ErdInspector({
  models,
  relationships,
  selectedEdgeId,
  selectedNodeId,
  onSelectEdge,
}: ErdInspectorProps) {
  const navigate = useNavigate()
  const handleOpenResource = (url: string) => navigate(url)

  const selectedEdge = selectedEdgeId
    ? relationships.find((r) => r.id === selectedEdgeId) ?? null
    : null

  let body: React.ReactNode
  // Edge wins over node when both are non-null — safety net; mutual
  // exclusion at the source means this is unreachable in practice.
  if (selectedEdge) {
    body = (
      <EdgeInspector
        relationship={selectedEdge}
        fromModelName={resolveModelName(selectedEdge.from_unique_id, models)}
        toModelName={
          selectedEdge.to_model_name ||
          resolveModelName(selectedEdge.to_unique_id, models)
        }
        onOpenResource={handleOpenResource}
      />
    )
  } else if (selectedNodeId) {
    const { outgoing, incoming } = partitionRelationshipsForNode(
      selectedNodeId,
      relationships,
    )
    body = (
      <NodeInspector
        model={models[selectedNodeId] ?? null}
        nodeId={selectedNodeId}
        outgoing={outgoing}
        incoming={incoming}
        models={models}
        onSelectEdge={onSelectEdge}
        onOpenResource={handleOpenResource}
      />
    )
  } else {
    body = <EmptyInspector />
  }

  return (
    <aside
      className="w-80 shrink-0 border-l overflow-y-auto flex flex-col"
      style={{
        background: 'var(--bg)',
        borderColor: 'var(--border)',
      }}
      data-testid="erd-inspector"
    >
      {body}
    </aside>
  )
}
