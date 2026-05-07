/**
 * ErdInspector — the right rail on the ERD page.
 *
 * Three render branches per origin requirements §5.7:
 *   1. **Empty** (no edge / no node selected): a hint + YAML snippet showing
 *      how to add a `relationships` test.
 *   2. **Edge selected**: editorial layout (dateline, headline, drop-cap body
 *      paragraph, pull quote, definition list, code excerpt, footer byline).
 *      Visual reference: `examples/erd-design-examples/variant-b.jsx`. We
 *      drop the serif font (the variant uses `var(--font-serif)`, which is
 *      not defined in our CSS) and lean on the project default sans + mono.
 *   3. **Node selected (no edge)**: U2 fills this in. Stub for now.
 *
 * The YAML excerpt synthesis is extracted to a pure helper
 * (`synthesizeRelationshipYaml`) so it can be unit-tested without DOM.
 */

import type {
  DocglowModel,
  ErdInferenceSource,
  ErdRelationship,
  ErdSeverity,
  ErdStatus,
} from '../../types'

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

function DTerm({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt
        style={{
          color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          paddingTop: 2,
        }}
      >
        {term}
      </dt>
      <dd>{children}</dd>
    </>
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
        className="px-5 pb-4"
        style={{
          color: 'var(--text-muted)',
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 11,
        }}
      >
        {totalRels} {totalRels === 1 ? 'relationship' : 'relationships'}
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
}

function EdgeInspector({
  relationship,
  fromModelName,
  toModelName,
}: EdgeInspectorProps) {
  const fromQualified = `${fromModelName}.${relationship.from_column}`
  const toQualified = `${toModelName}.${relationship.to_column}`

  const testBasename = basenameUniqueId(relationship.test_unique_id)
  const sevLabel = relationship.severity === 'error' ? 'build failures' : 'warnings'
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

  return (
    <div className="flex flex-col">
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
        <span>relationship</span>
      </div>

      {/* Headline */}
      <h2
        className="px-5 pb-4 leading-tight"
        style={{
          fontSize: 18,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          color: 'var(--text)',
        }}
        data-testid="erd-inspector-headline"
      >
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            fontSize: 15,
            color: 'var(--text)',
          }}
        >
          {fromQualified}
        </span>
        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
          {' '}references{' '}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            fontSize: 15,
            color: 'var(--text)',
          }}
        >
          {toQualified}
        </span>
      </h2>

      {/* Body paragraph (emphasized first letter, no float drop-cap). */}
      <div
        className="px-5 pb-5 text-sm"
        style={{
          color: 'var(--text)',
          lineHeight: 1.55,
        }}
      >
        <p>
          <span
            style={{
              fontSize: 17,
              fontWeight: 600,
              color: '#f59e0b',
            }}
          >
            E
          </span>
          very row of{' '}
          <code
            style={{
              fontFamily:
                'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
              fontSize: 12,
            }}
          >
            {fromModelName}
          </code>{' '}
          must point at a real{' '}
          <code
            style={{
              fontFamily:
                'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
              fontSize: 12,
            }}
          >
            {toModelName}
          </code>
          .{' '}
          {relationship.inference_source === 'meta' ? (
            <>
              This relationship is declared via{' '}
              <code
                style={{
                  fontFamily:
                    'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                  fontSize: 12,
                }}
              >
                meta.docglow.relationships
              </code>
              {' '}— Docglow surfaces it without a build-time check.
            </>
          ) : (
            <>
              The{' '}
              <code
                style={{
                  fontFamily:
                    'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                  fontSize: 12,
                }}
              >
                {testBasename ?? 'relationships'}
              </code>{' '}
              test guards this on every{' '}
              <code
                style={{
                  fontFamily:
                    'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                  fontSize: 12,
                }}
              >
                dbt build
              </code>{' '}
              — orphans surface as <em>{sevLabel}</em> rather than silent data
              drift.
            </>
          )}
        </p>
      </div>

      {/* Pull quote */}
      <blockquote
        className="mx-5 mb-5 px-4 py-3"
        style={{
          borderLeft: '3px solid #f59e0b',
          fontSize: 13,
          lineHeight: 1.45,
          color: 'var(--text)',
          background: 'color-mix(in oklab, #f59e0b 4%, transparent)',
        }}
      >
        <span
          style={{
            color: '#f59e0b',
            fontSize: 20,
            lineHeight: 0,
            position: 'relative',
            top: 6,
            marginRight: 4,
          }}
        >
          “
        </span>
        <span
          style={{
            fontFamily:
              'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            fontSize: 12,
          }}
        >
          {fromQualified}
        </span>
        <span> → </span>
        <span
          style={{
            fontFamily:
              'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            fontSize: 12,
          }}
        >
          {toQualified}
        </span>
        {relationship.inference_source === 'meta' && relationship.meta_file_path ? (
          <>
            <span> — declared in </span>
            <span
              style={{
                fontFamily:
                  'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                fontSize: 12,
              }}
            >
              {relationship.meta_file_path}
            </span>
            <span>.</span>
          </>
        ) : (
          <>
            <span> — enforced by the </span>
            <span
              style={{
                fontFamily:
                  'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                fontSize: 12,
              }}
            >
              {testBasename ?? 'relationships'}
            </span>
            <span> test.</span>
          </>
        )}
      </blockquote>

      {/* Definition list */}
      <dl
        className="px-5 pb-4 grid gap-y-2"
        style={{
          gridTemplateColumns: 'auto 1fr',
          columnGap: 16,
          fontSize: 13,
        }}
        data-testid="erd-inspector-dl"
      >
        <DTerm term="severity">
          <SoftBadge tone={SEVERITY_TONE[relationship.severity]}>
            {relationship.severity}
          </SoftBadge>
        </DTerm>
        <DTerm term="status">
          <SoftBadge tone={STATUS_TONE[relationship.status]}>
            {STATUS_LABEL[relationship.status]}
          </SoftBadge>
        </DTerm>
        <DTerm term="file">
          <code
            style={{
              fontFamily:
                'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
              fontSize: 12,
              color: 'var(--text)',
            }}
          >
            {relationship.meta_file_path ?? 'N/A'}
          </code>
        </DTerm>
        <DTerm term="test">
          <code
            style={{
              fontFamily:
                'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
              fontSize: 12,
              color: 'var(--text)',
            }}
          >
            {testBasename ?? 'N/A'}
          </code>
        </DTerm>
        <DTerm term="inference">
          <code
            style={{
              fontFamily:
                'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
              fontSize: 12,
              color: 'var(--text)',
            }}
          >
            {inferenceLabel[relationship.inference_source]}
          </code>
        </DTerm>
      </dl>

      {/* Code excerpt */}
      <div className="px-5 pb-5">
        <div
          className="mb-1"
          style={{
            color: 'var(--text-muted)',
            fontFamily:
              'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            fontSize: 10,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          excerpt
        </div>
        <pre
          className="px-3 py-2 rounded border whitespace-pre overflow-x-auto"
          style={{
            background: 'var(--bg-surface)',
            borderColor: 'var(--border)',
            fontFamily:
              'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
            color: 'var(--text)',
            fontSize: 12,
            lineHeight: 1.5,
          }}
          data-testid="erd-inspector-yaml"
        >
          {yamlExcerpt}
        </pre>
      </div>

      {/* Footer byline */}
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
        <span>inference: {inferenceLabel[relationship.inference_source]}</span>
        <span>·</span>
        <span>severity: {relationship.severity}</span>
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
