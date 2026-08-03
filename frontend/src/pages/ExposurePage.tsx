import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Markdown } from '../components/Markdown'
import {
  ColumnExpandControls,
  lineageViewModeSuffix,
  parseLineageViewMode,
  type LineageViewMode,
} from '../components/lineage/ColumnExpandControls'
import { FieldPathOnlyControl } from '../components/lineage/FieldPathOnlyControl'
import { LineageFlow } from '../components/lineage/LineageFlow'
import { TestBadge } from '../components/tests/TestBadge'
import { FilterDropdown } from '../components/ui/FilterDropdown'
import type { FilterState } from '../components/ui/FilterDropdown'
import { useColumnHighlightStore } from '../stores/columnHighlightStore'
import { useProjectStore } from '../stores/projectStore'
import { useTagFilterStore } from '../stores/tagFilterStore'
import { buildColumnsModeSubgraph } from '../utils/applyFieldPathFilter'
import { getColumnLineageCandidateIds } from '../utils/columnLineageGraph'
import { getDescendants, getSubgraph, type LineageDirection } from '../utils/graph'
import { applyFilters, computeSubgraphOptions, useFilterState } from '../utils/lineageFilters'
import { buildModelColumnsMap } from '../utils/modelColumns'
import type { TestStatus } from '../utils/colors'
import type { DocglowModel } from '../types'

const MATURITY_STYLES: Record<string, string> = {
  high: 'bg-success/10 text-success',
  medium: 'bg-warning/10 text-warning',
  low: 'bg-neutral/10 text-neutral',
}

interface UpstreamHealth {
  upstreamModels: number
  modelsWithTests: number
  totalTests: number
  pass: number
  warn: number
  fail: number
  overall: TestStatus
}

// Roll up test results across the exposure's resolvable upstream models so the
// page can surface a dbt-Explorer-style "data health" summary without any new
// data plumbing — every model already carries its own test_results.
function computeUpstreamHealth(
  dependsOn: string[],
  getModel: (uniqueId: string) => DocglowModel | undefined,
): UpstreamHealth | null {
  let upstreamModels = 0
  let modelsWithTests = 0
  let totalTests = 0
  let pass = 0
  let warn = 0
  let fail = 0

  for (const id of dependsOn) {
    const model = getModel(id)
    if (!model) continue
    upstreamModels += 1
    const results = model.test_results ?? []
    if (results.length > 0) modelsWithTests += 1
    for (const result of results) {
      switch (result.status) {
        case 'pass': pass += 1; totalTests += 1; break
        case 'warn': warn += 1; totalTests += 1; break
        case 'fail':
        case 'error': fail += 1; totalTests += 1; break
        default: break
      }
    }
  }

  if (upstreamModels === 0) return null

  const overall: TestStatus =
    fail > 0 ? 'fail' : warn > 0 ? 'warn' : totalTests > 0 ? 'pass' : 'none'

  return { upstreamModels, modelsWithTests, totalTests, pass, warn, fail, overall }
}

function formatOwner(owner: Record<string, string>): string | null {
  const preferred = ['name', 'email', 'team']
    .map((key) => owner[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  if (preferred.length > 0) return preferred.join(' · ')

  const pairs = Object.entries(owner)
    .filter(([, value]) => value.trim().length > 0)
    .map(([key, value]) => `${key}: ${value}`)

  return pairs.length > 0 ? pairs.join(' · ') : null
}

export function ExposurePage() {
  const { id, view: viewParam } = useParams<{ id: string; view?: string }>()
  const navigate = useNavigate()
  const { data, getExposure, getModel } = useProjectStore()

  const decodedId = id ? decodeURIComponent(id) : ''
  const exposure = decodedId ? getExposure(decodedId) : undefined

  const upstreamHealth = useMemo(
    () => (exposure ? computeUpstreamHealth(exposure.depends_on, getModel) : null),
    [exposure, getModel],
  )

  // Lineage controls — same surface as ModelPage (exposures default to upstream).
  const [depth, setDepth] = useState(2)
  const [parentsDepth, setParentsDepth] = useState(2)
  const [childrenDepth, setChildrenDepth] = useState(0)
  const [direction, setDirection] = useState<LineageDirection>('upstream')
  const [layoutMode, setLayoutMode] = useState<'layered' | 'dag'>(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('dg-lineage-layout') : null
    return stored === 'layered' || stored === 'dag' ? stored : 'dag'
  })
  useEffect(() => {
    window.localStorage.setItem('dg-lineage-layout', layoutMode)
  }, [layoutMode])
  const [showParentSiblings, setShowParentSiblings] = useState(false)
  const [fieldPathOnly, setFieldPathOnly] = useState(false)
  const [lineageFullscreen, setLineageFullscreen] = useState(false)
  const [lineageViewMode, setLineageViewModeState] = useState<LineageViewMode>(() =>
    parseLineageViewMode(viewParam),
  )
  useEffect(() => {
    setLineageViewModeState(parseLineageViewMode(viewParam))
  }, [viewParam])

  const selectLineageViewMode = useCallback((mode: LineageViewMode) => {
    setLineageViewModeState(mode)
    if (!decodedId) return
    const encoded = encodeURIComponent(decodedId)
    navigate(`/exposure/${encoded}${lineageViewModeSuffix(mode)}`, { replace: true })
  }, [navigate, decodedId])

  const selectedColumn = useColumnHighlightStore((s) => s.selectedColumn)
  const [typeFilter, toggleType, setTypeMode, clearTypes] = useFilterState()
  const {
    selected: globalTagSelected,
    mode: globalTagMode,
    toggle: toggleTag,
    setMode: setTagMode,
    clear: clearTags,
  } = useTagFilterStore()
  const tagFilter: FilterState = useMemo(
    () => ({ mode: globalTagMode, selected: new Set(globalTagSelected) }),
    [globalTagSelected, globalTagMode],
  )
  const [folderFilter, toggleFolder, setFolderMode, clearFolders] = useFilterState()
  const [layerFilter, toggleLayer, setLayerMode, clearLayers] = useFilterState()
  const [modelFilter, toggleModel, setModelFilterMode, clearModels] = useFilterState()

  const rawSubgraph = useMemo(() => {
    if (!data?.lineage || !decodedId) return { nodes: [], edges: [] }
    return getSubgraph(
      decodedId,
      data.lineage.nodes,
      data.lineage.edges,
      depth,
      direction,
      parentsDepth,
      childrenDepth,
      showParentSiblings,
    )
  }, [data?.lineage, decodedId, depth, direction, parentsDepth, childrenDepth, showParentSiblings])

  const filteredSubgraph = useMemo(() => {
    const base = applyFilters(
      rawSubgraph.nodes,
      rawSubgraph.edges,
      typeFilter,
      tagFilter,
      folderFilter,
      layerFilter,
    )
    if (modelFilter.selected.size === 0) return base
    const effectiveExclude = new Set<string>()
    if (modelFilter.mode === 'exclude') {
      for (const id of modelFilter.selected) {
        for (const d of getDescendants(id, rawSubgraph.edges)) effectiveExclude.add(d)
      }
      effectiveExclude.delete(decodedId)
    }
    const keep = base.nodes.filter((n) => {
      if (n.id === decodedId) return true
      if (modelFilter.mode === 'include') return modelFilter.selected.has(n.id)
      return !effectiveExclude.has(n.id)
    })
    const ids = new Set(keep.map((n) => n.id))
    return {
      nodes: keep,
      edges: base.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    }
  }, [rawSubgraph, typeFilter, tagFilter, folderFilter, layerFilter, modelFilter, decodedId])

  const displaySubgraph = useMemo(() => {
    if (lineageViewMode !== 'columns') return filteredSubgraph
    return buildColumnsModeSubgraph(filteredSubgraph.nodes, filteredSubgraph.edges, {
      allNodes: data?.lineage.nodes ?? [],
      allEdges: data?.lineage.edges ?? [],
      columnLineage: data?.column_lineage,
      fieldPathOnly,
      selectedColumn,
      direction,
      alwaysKeep: decodedId ? [decodedId] : [],
    })
  }, [
    filteredSubgraph,
    lineageViewMode,
    fieldPathOnly,
    selectedColumn,
    data?.column_lineage,
    data?.lineage.nodes,
    data?.lineage.edges,
    direction,
    decodedId,
  ])

  const columnLineageCandidateIds = useMemo(
    () => getColumnLineageCandidateIds(displaySubgraph.nodes, data?.column_lineage),
    [displaySubgraph, data?.column_lineage],
  )

  const subgraphOptions = useMemo(
    () => computeSubgraphOptions(rawSubgraph.nodes),
    [rawSubgraph.nodes],
  )

  const hasActiveFilters =
    typeFilter.selected.size > 0 ||
    tagFilter.selected.size > 0 ||
    folderFilter.selected.size > 0 ||
    layerFilter.selected.size > 0 ||
    modelFilter.selected.size > 0

  const clearAllFilters = useCallback(() => {
    clearTypes()
    clearTags()
    clearFolders()
    clearLayers()
    clearModels()
  }, [clearTypes, clearTags, clearFolders, clearLayers, clearModels])

  const modelColumns = useMemo(() => {
    if (!data) return {}
    return buildModelColumnsMap(data)
  }, [data])

  const hasLineage = filteredSubgraph.nodes.length > 0

  if (!exposure) {
    return (
      <div className="text-[var(--text-muted)]">
        Exposure not found: {id ? decodeURIComponent(id) : 'unknown'}
      </div>
    )
  }

  const owner = formatOwner(exposure.owner)
  const maturity = exposure.maturity?.trim().toLowerCase()
  const title = exposure.label?.trim() || exposure.name

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 mb-2">
          <div className="flex items-center gap-3 flex-wrap min-w-0">
            <h1 className="text-2xl font-bold">{title}</h1>
            <span className="px-2 py-0.5 text-xs font-medium rounded bg-warning/10 text-warning">
              Exposure
            </span>
            {maturity && (
              <span
                className={`px-2 py-0.5 text-xs font-medium rounded capitalize ${
                  MATURITY_STYLES[maturity] ?? 'bg-neutral/10 text-neutral'
                }`}
                title="Maturity is declared by the exposure's author in dbt (high / medium / low). It is not computed by Docglow."
              >
                {maturity}
              </span>
            )}
          </div>
          {exposure.url && (
            <a
              href={exposure.url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm
                         font-medium text-white hover:brightness-110 transition-all"
            >
              Open in Dashboard
              <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
            </a>
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-sm text-[var(--text-muted)]">
          {exposure.type && <span>Type: {exposure.type}</span>}
          <span>
            {exposure.depends_on.length} upstream {exposure.depends_on.length === 1 ? 'dependency' : 'dependencies'}
          </span>
          {owner && <span>Owner: {owner}</span>}
        </div>
        {exposure.description && (
          <Markdown content={exposure.description} className="mt-3 text-sm" />
        )}
      </div>

      {upstreamHealth && (
        <div className="mb-6 rounded-lg border border-[var(--border)] bg-[var(--bg-surface)] p-4">
          <div className="flex items-center gap-3 flex-wrap">
            <h2 className="text-sm font-semibold">Upstream data health</h2>
            <TestBadge
              status={upstreamHealth.overall}
              label={
                upstreamHealth.overall === 'none'
                  ? 'no tests'
                  : upstreamHealth.overall === 'pass'
                    ? 'healthy'
                    : upstreamHealth.overall === 'warn'
                      ? 'warnings'
                      : 'failing'
              }
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-[var(--text-muted)]">
            <span>
              {upstreamHealth.modelsWithTests}/{upstreamHealth.upstreamModels} upstream models tested
            </span>
            {upstreamHealth.totalTests > 0 ? (
              <span>
                {upstreamHealth.totalTests} tests:{' '}
                <span className="text-success">{upstreamHealth.pass} passing</span>
                {upstreamHealth.warn > 0 && <>, <span className="text-warning">{upstreamHealth.warn} warning</span></>}
                {upstreamHealth.fail > 0 && <>, <span className="text-danger">{upstreamHealth.fail} failing</span></>}
              </span>
            ) : (
              <span>No tests defined on upstream models.</span>
            )}
          </div>
        </div>
      )}

      {exposure.tags.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">Tags</h2>
          <div className="flex flex-wrap gap-2">
            {exposure.tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-1 text-xs rounded-full border border-[var(--border)] bg-[var(--bg-surface)]"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={lineageFullscreen
        ? 'fixed inset-0 z-50 bg-[var(--bg)] flex flex-col'
        : 'flex flex-col'
      }>
        <div className="flex items-center gap-2 mb-2 flex-wrap shrink-0 px-1">
          <h2 className="text-lg font-semibold mr-2">Lineage Context</h2>

          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--text-muted)]">Depth</label>
            <input
              type="range"
              min={1}
              max={6}
              value={depth}
              onChange={(e) => {
                const v = Number(e.target.value)
                setDepth(v)
                setParentsDepth(v)
                setChildrenDepth(direction === 'upstream' ? 0 : v)
              }}
              className="w-20 accent-[var(--primary)]"
            />
            <span className="text-xs font-medium w-4 text-center">{depth}</span>
          </div>

          <div className="h-4 w-px bg-[var(--border)]" />

          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--text-muted)]">Parents</label>
            <input
              type="range"
              min={0}
              max={6}
              value={parentsDepth}
              onChange={(e) => setParentsDepth(Number(e.target.value))}
              className="w-20 accent-[var(--primary)]"
            />
            <span className="text-xs font-medium w-4 text-center">{parentsDepth}</span>
          </div>

          <div className="h-4 w-px bg-[var(--border)]" />

          <div className="flex items-center gap-2">
            <label className="text-xs text-[var(--text-muted)]">Children</label>
            <input
              type="range"
              min={0}
              max={6}
              value={childrenDepth}
              onChange={(e) => setChildrenDepth(Number(e.target.value))}
              className="w-20 accent-[var(--primary)]"
            />
            <span className="text-xs font-medium w-4 text-center">{childrenDepth}</span>
          </div>

          <div className="h-4 w-px bg-[var(--border)]" />

          <div className="flex items-center rounded overflow-hidden border border-[var(--border)]">
            {(['upstream', 'both', 'downstream'] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => setDirection(dir)}
                className={`px-2 py-0.5 text-xs cursor-pointer transition-colors flex items-center gap-1
                  ${direction === dir
                    ? 'bg-primary text-white'
                    : 'bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-surface)]'
                  }`}
                title={dir === 'both' ? 'Show upstream & downstream' : `Show ${dir} only`}
              >
                {dir === 'upstream' && (
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M19 12H5M12 5l-7 7" />
                  </svg>
                )}
                {dir === 'both' && (
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 12h14M8 8l-4 4 4 4M16 8l4 4-4 4" />
                  </svg>
                )}
                {dir === 'downstream' && (
                  <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 12h14M12 5l7 7" />
                  </svg>
                )}
                {dir === 'upstream' ? 'Up' : dir === 'downstream' ? 'Down' : 'Both'}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-[var(--border)]" />

          <div className="flex items-center rounded overflow-hidden border border-[var(--border)]">
            {(['layered', 'dag'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setLayoutMode(m)}
                className={`px-2 py-0.5 text-xs cursor-pointer transition-colors
                  ${layoutMode === m
                    ? 'bg-primary text-white'
                    : 'bg-[var(--bg)] text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                title={m === 'layered' ? 'Layered (semantic layers)' : 'Direct DAG (topological)'}
              >
                {m === 'layered' ? 'Layered' : 'DAG'}
              </button>
            ))}
          </div>

          <div className="h-4 w-px bg-[var(--border)]" />

          <ColumnExpandControls
            candidateIds={columnLineageCandidateIds}
            hasSqlGraph={false}
            mode={lineageViewMode}
            onModeChange={selectLineageViewMode}
          />

          <div className="h-4 w-px bg-[var(--border)]" />

          <label
            className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer select-none"
            title="Also show siblings — the other models fed by the exposure's direct parents"
          >
            <input
              type="checkbox"
              checked={showParentSiblings}
              onChange={(e) => setShowParentSiblings(e.target.checked)}
              className="accent-[var(--primary)] cursor-pointer"
            />
            Parent outputs
          </label>

          <FieldPathOnlyControl
            mode={lineageViewMode}
            checked={fieldPathOnly}
            onChange={setFieldPathOnly}
            hasSelection={selectedColumn != null}
          />

          <div className="h-4 w-px bg-[var(--border)]" />

          <FilterDropdown
            label="Types"
            options={subgraphOptions.types}
            filter={typeFilter}
            onToggle={toggleType}
            onSetMode={setTypeMode}
            onClear={clearTypes}
          />
          {subgraphOptions.tags.length > 0 && (
            <FilterDropdown
              label="Tags"
              options={subgraphOptions.tags}
              filter={tagFilter}
              onToggle={toggleTag}
              onSetMode={setTagMode}
              onClear={clearTags}
            />
          )}
          {subgraphOptions.folders.length > 0 && (
            <FilterDropdown
              label="Folders"
              options={subgraphOptions.folders}
              filter={folderFilter}
              onToggle={toggleFolder}
              onSetMode={setFolderMode}
              onClear={clearFolders}
              displayLabel={(v) => v.split('/').pop() ?? v}
            />
          )}
          {subgraphOptions.layers.length > 0 && (
            <FilterDropdown
              label="Layers"
              options={subgraphOptions.layers}
              filter={layerFilter}
              onToggle={toggleLayer}
              onSetMode={setLayerMode}
              onClear={clearLayers}
              displayLabel={(rank) =>
                (data?.lineage.layer_config ?? []).find((l) => String(l.rank) === rank)?.name
                ?? `Layer ${rank}`
              }
              optionAccent={(rank) =>
                (data?.lineage.layer_config ?? []).find((l) => String(l.rank) === rank)?.color
              }
            />
          )}
          {rawSubgraph.nodes.length > 1 && (
            <FilterDropdown
              label="Models"
              options={rawSubgraph.nodes.map((n) => n.id).sort()}
              filter={modelFilter}
              onToggle={toggleModel}
              onSetMode={setModelFilterMode}
              onClear={clearModels}
              displayLabel={(id) =>
                rawSubgraph.nodes.find((n) => n.id === id)?.name ?? id
              }
            />
          )}

          {hasActiveFilters && (
            <button
              onClick={clearAllFilters}
              className="px-2 py-1 text-xs rounded bg-danger/10 text-danger hover:bg-danger/20 cursor-pointer transition-colors"
            >
              Clear filters
            </button>
          )}

          <span className="text-xs text-[var(--text-muted)] ml-auto">
            {displaySubgraph.nodes.length} nodes · {displaySubgraph.edges.length} edges
          </span>

          <button
            onClick={() => setLineageFullscreen((f) => !f)}
            className="p-1 rounded hover:bg-[var(--bg-surface)] cursor-pointer transition-colors text-[var(--text-muted)] hover:text-[var(--text)]"
            title={lineageFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {lineageFullscreen ? (
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3" />
              </svg>
            ) : (
              <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            )}
          </button>
        </div>

        {hasLineage ? (
          <div
            className={lineageFullscreen ? 'flex-1 relative min-h-0' : 'relative'}
            style={lineageFullscreen ? undefined : { height: 'calc(100vh - 360px)', minHeight: 400 }}
          >
            <LineageFlow
              nodes={
                layoutMode === 'dag'
                  ? displaySubgraph.nodes.map((n) => ({ ...n, layer: undefined }))
                  : displaySubgraph.nodes
              }
              edges={displaySubgraph.edges}
              pinnedIds={new Set([decodedId])}
              layerConfig={layoutMode === 'dag' ? [] : data?.lineage.layer_config}
              modelColumns={modelColumns}
              columnLineageData={data?.column_lineage}
              joinKeysData={data?.join_keys}
              joinBasesData={data?.join_bases}
              joinIndirectData={data?.join_indirect}
              fieldPathOnly={fieldPathOnly}
              onNavigateAway={() => setLineageFullscreen(false)}
            />
          </div>
        ) : (
          <div className="border border-[var(--border)] rounded-lg p-4 text-sm text-[var(--text-muted)]">
            No lineage context is available for this exposure.
          </div>
        )}
      </div>
    </div>
  )
}
