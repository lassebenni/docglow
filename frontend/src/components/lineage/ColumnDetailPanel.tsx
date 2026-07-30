import type { ColumnLineageDependency } from '../../types'
import type { TransformationType } from '../../types'
import { transformationGlyph, transformationLabel } from '../../utils/columnTransforms'
import { PanelRow } from './LineagePanels'

export interface ColumnDetail {
  modelId: string
  columnName: string
  kind: TransformationType | null
  expression: string | null
  upstreamDeps: ColumnLineageDependency[]
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
  return (
    <div
      className="react-flow__panel"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: 300,
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
      <div style={{ fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--text, #0f172a)', marginBottom: 4 }}>
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

        {detail.upstreamDeps.length > 0 && (
          <div>
            <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6 }}>From</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {detail.upstreamDeps.map((dep) => (
                <div
                  key={`${dep.source_model}:${dep.source_column}`}
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: 'var(--text, #0f172a)',
                    background: 'var(--bg-surface, #f1f5f9)',
                    borderRadius: 6,
                    padding: '6px 8px',
                    wordBreak: 'break-word',
                  }}
                >
                  {nameOf(dep.source_model!)}.{dep.source_column}
                </div>
              ))}
            </div>
          </div>
        )}

        {detail.kind === 'constant' && detail.upstreamDeps.length === 0 && (
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
          <div>
            <div style={{ color: 'var(--text-muted, #64748b)', marginBottom: 6 }}>Formula</div>
            <pre
              style={{
                margin: 0,
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: 'var(--text, #0f172a)',
                background: 'var(--bg-surface, #f1f5f9)',
                borderRadius: 6,
                padding: '8px 10px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {detail.expression}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
