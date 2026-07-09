import { useCallback, useEffect, useState } from 'react'
import type { CustomDoc } from '../../types'

interface CustomDocFrameProps {
  doc: CustomDoc
}

function FullscreenToggle({
  isFullscreen,
  onToggle,
}: {
  isFullscreen: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid="custom-doc-fullscreen-toggle"
      className="p-1 rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors text-[var(--text-muted)] hover:text-[var(--text)]"
      title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
    >
      {isFullscreen ? (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3" />
        </svg>
      ) : (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
        </svg>
      )}
    </button>
  )
}

export function CustomDocFrame({ doc }: CustomDocFrameProps) {
  const [isFullscreen, setIsFullscreen] = useState(false)

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen(f => !f)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isFullscreen])

  return (
    <div
      data-testid={`custom-doc-${doc.slug}`}
      className={isFullscreen
        ? 'fixed inset-0 z-50 bg-[var(--bg)] flex flex-col'
        : 'rounded border border-[var(--border)] overflow-hidden bg-[var(--bg-surface)] flex flex-col'
      }
    >
      <div className="flex items-center justify-between gap-2 px-2 py-1 shrink-0 border-b border-[var(--border)]">
        <span className="text-sm text-[var(--text-muted)] truncate">{doc.label}</span>
        <FullscreenToggle isFullscreen={isFullscreen} onToggle={toggleFullscreen} />
      </div>
      <iframe
        title={doc.label}
        src={doc.url}
        className="w-full flex-1 border-0 min-h-0"
        style={isFullscreen ? undefined : { minHeight: '85vh' }}
        // Cheatsheets use inline JS, Mermaid, and ECharts — scripts must be allowed.
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  )
}
