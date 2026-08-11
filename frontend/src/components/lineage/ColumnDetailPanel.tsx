import { useMemo } from 'react'
import type { ColumnLineageDependency } from '../../types'
import type { TransformationType } from '../../types'
import { transformationGlyph, transformationLabel } from '../../utils/columnTransforms'
import type { FormulaLeafSource } from '../../utils/measureFormulaResolve'
import { groupFormulaSourcesByColumn } from '../../utils/measureFormulaResolve'
import { PanelRow } from './LineagePanels'

export interface ColumnDetail {
  modelId: string
  columnName: string
  kind: TransformationType | null
  expression: string | null
  /** When set, English model.column rewrite of measure refs in ``expression``. */
  resolvedExpression?: string | null
  upstreamDeps: ColumnLineageDependency[]
  /**
   * Formula leaf measures (Dutch name → warehouse column). Prefer over
   * ``upstreamDeps`` when present — one row per measure even if columns repeat.
   */
  formulaSources?: FormulaLeafSource[]
}

function FormulaBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6 }}>{label}</div>
      <pre
        style={{
          margin: 0,
          fontSize: 11,
          lineHeight: 1.45,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'var(--text, #0f172a)',
          background: 'var(--bg-surface, #f1f5f9)',
          borderRadius: 6,
          padding: '8px 10px',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </pre>
    </div>
  )
}

function FromDepChip({
  measureNames,
  modelLabel,
  column,
}: {
  measureNames?: string[]
  modelLabel: string
  column: string
}) {
  const measures = measureNames ?? []
  return (
    <div
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--text, #0f172a)',
        background: 'var(--bg-surface, #f1f5f9)',
        borderRadius: 6,
        padding: '8px 10px',
        lineHeight: 1.35,
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
      title={
        measures.length > 0
          ? `${measures.join(', ')} → ${modelLabel}.${column}`
          : `${modelLabel}.${column}`
      }
    >
      <div style={{ fontSize: 10, color: 'var(--text-muted, #64748b)' }}>
        {modelLabel}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 2 }}>{column}</div>
      {measures.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted, #64748b)', marginTop: 6 }}>
          {measures.length === 1 ? (
            <>via {measures[0]}</>
          ) : (
            <>
              via {measures.length} measures:{' '}
              <span style={{ color: 'var(--text, #0f172a)' }}>{measures.join(' · ')}</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function ColumnDetailPanel({
  detail,
  nameOf,
  onClose,
}: {
  detail: ColumnDetail
  nameOf: (modelId: string) => string
  onClose: () => void
}) {
  const hasResolved =
    !!detail.resolvedExpression &&
    detail.resolvedExpression !== detail.expression

  const formulaSources = detail.formulaSources ?? []
  const grouped = useMemo(
    () => groupFormulaSourcesByColumn(formulaSources),
    [formulaSources],
  )
  const useFormulaFrom = grouped.length > 0
  const measureCount = formulaSources.length
  const fromCount = useFormulaFrom ? grouped.length : detail.upstreamDeps.length

  return (
    <div
      className="react-flow__panel"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 380,
        maxWidth: '42vw',
        height: '100%',
        background: 'var(--bg, #fff)',
        borderLeft: '1px solid var(--border, #e2e8f0)',
        zIndex: 10,
        overflow: 'auto',
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text, #0f172a)', lineHeight: 1.3 }}>
          Column
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: 2,
            color: 'var(--text-muted, #64748b)', flexShrink: 0, marginLeft: 8,
          }}
        >
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          color: 'var(--text, #0f172a)',
          marginBottom: 4,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {detail.columnName}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted, #64748b)', marginBottom: 16 }}>
        {nameOf(detail.modelId)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 }}>
        <PanelRow
          label="Kind"
          value={
            detail.kind
              ? `${transformationGlyph(detail.kind) ?? ''} ${transformationLabel(detail.kind)}`.trim()
              : '—'
          }
        />

        {fromCount > 0 && (
          <div>
            <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6 }}>
              From ({fromCount}
              {useFormulaFrom && measureCount > fromCount
                ? ` columns · ${measureCount} measures`
                : ''}
              )
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {useFormulaFrom
                ? grouped.map((src) => (
                    <FromDepChip
                      key={`${src.sourceModel}:${src.sourceColumn}`}
                      measureNames={src.measureNames}
                      modelLabel={nameOf(src.sourceModel)}
                      column={src.sourceColumn}
                    />
                  ))
                : detail.upstreamDeps.map((dep) => (
                    <FromDepChip
                      key={`${dep.source_model}:${dep.source_column}`}
                      modelLabel={nameOf(dep.source_model!)}
                      column={dep.source_column!}
                    />
                  ))}
            </div>
          </div>
        )}

        {detail.kind === 'constant' && fromCount === 0 && (
          <div style={{ color: 'var(--text-muted, #64748b)', lineHeight: 1.45 }}>
            No upstream — constant expression
            {detail.expression?.toUpperCase() === 'NULL'
              ? ' (compiled macro may not have expanded).'
              : '.'}
          </div>
        )}

        {detail.kind === 'untraced' && (
          <div style={{ color: 'var(--text-muted, #64748b)', lineHeight: 1.45 }}>
            Could not resolve upstream lineage for this column.
          </div>
        )}

        {detail.expression && (
          <FormulaBlock
            label={hasResolved ? 'DAX formula' : 'Formula'}
            text={detail.expression}
          />
        )}

        {hasResolved && detail.resolvedExpression && (
          <FormulaBlock
            label="Resolved (English columns)"
            text={detail.resolvedExpression}
          />
        )}
      </div>
    </div>
  )
}
