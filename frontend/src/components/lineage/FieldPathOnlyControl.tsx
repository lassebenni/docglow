import type { LineageViewMode } from './ColumnExpandControls'

interface FieldPathOnlyControlProps {
  mode: LineageViewMode
  checked: boolean
  onChange: (checked: boolean) => void
  /** True when a column/field is currently selected in the graph. */
  hasSelection: boolean
}

/**
 * Columns-mode toggle: when a field is selected, hide table parents that are
 * not on that field's column-lineage path.
 */
export function FieldPathOnlyControl({
  mode,
  checked,
  onChange,
  hasSelection,
}: FieldPathOnlyControlProps) {
  if (mode !== 'columns') return null

  const title = hasSelection
    ? 'Show only models on the selected field\'s column lineage path'
    : 'Select a field in the graph to filter to its lineage path'

  return (
    <label
      className={`flex items-center gap-1.5 text-xs cursor-pointer select-none ${
        checked && !hasSelection
          ? 'text-[var(--text-muted)]/70'
          : 'text-[var(--text-muted)]'
      }`}
      title={title}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--primary)] cursor-pointer"
      />
      Field path only
    </label>
  )
}
