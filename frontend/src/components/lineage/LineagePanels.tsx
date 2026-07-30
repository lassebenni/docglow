import { formatJoinPredicate, type EdgeJoinKey } from '../../utils/joinKeys'

export function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--text-muted, #64748b)' }}>{label}</span>
      <span style={{ color: 'var(--text, #0f172a)', fontWeight: 500, textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

export function JoinKeysPanel({
  sourceId,
  targetId,
  pairs,
  nameOf,
  onClose,
}: {
  sourceId: string
  targetId: string
  pairs: readonly EdgeJoinKey[]
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
          Join keys
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
      <div style={{ fontSize: 12, color: 'var(--text-muted, #64748b)', marginBottom: 12 }}>
        {nameOf(sourceId)} → {nameOf(targetId)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {pairs.map((pair, i) => (
          <div
            key={`${pair.source_column}-${pair.target_column}-${i}`}
            style={{
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: 'var(--text, #0f172a)',
              background: 'var(--bg-surface, #f1f5f9)',
              borderRadius: 6,
              padding: '8px 10px',
              wordBreak: 'break-word',
            }}
          >
            {formatJoinPredicate(pair, nameOf)}
            {pair.join_type && (
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted, #64748b)', fontFamily: 'inherit' }}>
                {pair.join_type} join
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
