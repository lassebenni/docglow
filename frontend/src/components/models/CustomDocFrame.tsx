import type { CustomDoc } from '../../types'

interface CustomDocFrameProps {
  doc: CustomDoc
}

export function CustomDocFrame({ doc }: CustomDocFrameProps) {
  return (
    <div
      data-testid={`custom-doc-${doc.slug}`}
      className="rounded border border-[var(--border)] overflow-hidden bg-[var(--bg-surface)]"
      style={{ minHeight: '70vh' }}
    >
      <iframe
        title={doc.label}
        src={doc.url}
        className="w-full border-0"
        style={{ minHeight: '70vh' }}
        sandbox="allow-same-origin"
      />
    </div>
  )
}
