import { useMemo, useState, useCallback, useEffect } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useProjectStore } from '../stores/projectStore'
import { useTagFilterStore } from '../stores/tagFilterStore'
import { ColumnTable } from '../components/models/ColumnTable'
import { CustomDocFrame } from '../components/models/CustomDocFrame'
import { SampleDataTable } from '../components/models/SampleDataTable'
import { SqlViewer } from '../components/models/SqlViewer'
import { TestBadge } from '../components/tests/TestBadge'
import { LineageFlow } from '../components/lineage/LineageFlow'
import { StatisticsTab } from '../components/models/StatisticsTab'
import { QuestionsTab } from '../components/models/QuestionsTab'
import { ColumnExpandControls } from '../components/lineage/ColumnExpandControls'
import { ErdCanvas } from '../components/erd/ErdCanvas'
import { FilterDropdown } from '../components/ui/FilterDropdown'
import type { FilterState } from '../components/ui/FilterDropdown'
import { Markdown } from '../components/Markdown'
import { materializationLabel } from '../utils/colors'
import { formatFqn } from '../utils/formatting'
import { getSubgraph, getDescendants, type LineageDirection } from '../utils/graph'
import { applyFilters, useFilterState, computeSubgraphOptions } from '../utils/lineageFilters'
import { buildModelColumnsMap } from '../utils/modelColumns'
import { buildDownstreamMap, getColumnLineageCandidateIds } from '../utils/columnLineageGraph'
import { getModelErdSubgraph } from '../utils/erdSubgraph'
import type { DocglowModel } from '../types'

const RESOURCE_TYPE_META: Record<string, { label: string; color: string; bg: string }> = {
  model:    { label: 'M', color: '#2563eb', bg: '#2563eb18' },
  source:   { label: 'S', color: '#16a34a', bg: '#16a34a18' },
  seed:     { label: 'Se', color: '#6b7280', bg: '#6b728018' },
  snapshot: { label: 'Sn', color: '#7c3aed', bg: '#7c3aed18' },
  exposure: { label: 'E', color: '#d97706', bg: '#d9770618' },
  metric:   { label: 'Mt', color: '#7c3aed', bg: '#7c3aed18' },
}

function parseDepId(id: string): { resourceType: string; name: string; navType: string } {
  const resourceType = id.split('.')[0] ?? 'model'
  const name = id.split('.').pop()!
  const navType = resourceType === 'source' ? 'source' : 'model'
  return { resourceType, name, navType }
}

const DEPENDENCY_COLLAPSE_THRESHOLD = 20

function DependencyList({
  label,
  ids,
  onNavigate,
}: {
  label: string
  ids: string[]
  onNavigate: (type: string, id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)

  const sorted = useMemo(() => {
    return [...ids]
      .map(id => ({ id, ...parseDepId(id) }))
      .sort((a, b) => {
        // Sort by resource type first, then alphabetically by name
        const typeOrder = ['source', 'model', 'seed', 'snapshot', 'exposure', 'metric']
        const aIdx = typeOrder.indexOf(a.resourceType)
        const bIdx = typeOrder.indexOf(b.resourceType)
        if (aIdx !== bIdx) return aIdx - bIdx
        return a.name.localeCompare(b.name)
      })
  }, [ids])

  const isCollapsible = sorted.length > DEPENDENCY_COLLAPSE_THRESHOLD
  const visible = isCollapsible && !expanded ? sorted.slice(0, DEPENDENCY_COLLAPSE_THRESHOLD) : sorted
  const hiddenCount = sorted.length - DEPENDENCY_COLLAPSE_THRESHOLD

  return (
    <div className="flex-1 min-w-0">
      <h3 className="font-medium text-[var(--text-muted)] mb-2">{label} ({ids.length})</h3>
      <div className="flex flex-wrap gap-1">
        {visible.map(dep => {
          const meta = RESOURCE_TYPE_META[dep.resourceType] ?? RESOURCE_TYPE_META.model
          return (
            <button
              key={dep.id}
              onClick={() => onNavigate(dep.navType, dep.id)}
              title={`${dep.resourceType}: ${dep.id}`}
              className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs
                         hover:brightness-90 transition-all cursor-pointer"
              style={{ background: meta.bg, color: meta.color }}
            >
              <span
                className="inline-flex items-center justify-center rounded text-[9px] font-bold shrink-0"
                style={{
                  width: 18,
                  height: 14,
                  background: meta.color,
                  color: '#fff',
                  lineHeight: 1,
                }}
              >
                {meta.label}
              </span>
              {dep.name}
            </button>
          )
        })}
        {isCollapsible && (
          <button
            onClick={() => setExpanded(prev => !prev)}
            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium
                       bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text)]
                       border border-[var(--border)] cursor-pointer transition-colors"
          >
            {expanded ? 'Show less' : `+${hiddenCount} more`}
          </button>
        )}
      </div>
    </div>
  )
}

type BuiltInTab = 'columns' | 'documentation' | 'questions' | 'sql' | 'data' | 'lineage' | 'erd' | 'tests' | 'statistics'

const BUILT_IN_TABS = [
  'columns', 'documentation', 'questions', 'sql', 'data', 'lineage', 'erd', 'tests', 'statistics',
] as const satisfies readonly BuiltInTab[]

function isBuiltInTab(tab: string): tab is BuiltInTab {
  return (BUILT_IN_TABS as readonly string[]).includes(tab)
}

function parseTab(raw: string | undefined, customSlugs: readonly string[]): string {
  const candidate = raw ?? ''
  if (isBuiltInTab(candidate)) return candidate
  if (customSlugs.includes(candidate)) return candidate
  return 'columns'
}

export function ModelPage() {
  const { id, tab: tabParam } = useParams<{ id: string; tab?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { data, getModel, getColumnLineage } = useProjectStore()
  const [activeTab, setActiveTab] = useState<string>(() => parseTab(tabParam, []))
  const [sqlMode, setSqlMode] = useState<'compiled' | 'raw'>('compiled')

  const decodedId = id ? decodeURIComponent(id) : ''
  const model = decodedId ? getModel(decodedId) : undefined

  const customDocs = model?.custom_docs ?? []
  const customSlugs = useMemo(() => customDocs.map(doc => doc.slug), [customDocs])

  // URL → state: keep activeTab in sync with the :tab segment so browser
  // back/forward and copy-pasted deep links land on the right tab.
  useEffect(() => {
    setActiveTab(parseTab(tabParam, customSlugs))
  }, [tabParam, customSlugs])

  // State → URL: update the path on every tab click so the address bar is
  // shareable.  Uses replace so a user clicking through five tabs doesn't
  // pile five history entries onto the back button.  `columns` is the
  // canonical "no tab segment" URL, matching the existing column-anchor
  // links and any external bookmarks that predate this route.
  const selectTab = useCallback((tab: string) => {
    setActiveTab(tab)
    if (!decodedId) return
    const encoded = encodeURIComponent(decodedId)
    const path = tab === 'columns' ? `/model/${encoded}` : `/model/${encoded}/${tab}`
    // Column anchors (#col-*) only apply on the columns tab; carrying them
    // into other tab URLs would re-trigger the scroll effect below and snap
    // back to columns (e.g. Statistics → Columns).
    const colAnchor = tab === 'columns' && location.hash.startsWith('#col-')
      ? location.hash
      : ''
    navigate(path + colAnchor, { replace: true })
  }, [navigate, decodedId, location.hash])

  // Scroll to column anchor when navigating with a hash (e.g. #col-closer_id)
  useEffect(() => {
    const hash = location.hash
    if (!hash || !hash.startsWith('#col-')) return
    // Deep links to other tabs (e.g. /statistics) must not be overridden.
    if (tabParam && tabParam !== 'columns') return

    // Ensure we're on the columns tab
    setActiveTab('columns')

    // Delay to allow the tab content to render
    const timer = setTimeout(() => {
      const el = document.getElementById(hash.slice(1))
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        // Brief highlight flash
        el.style.transition = 'background-color 0.3s'
        el.style.backgroundColor = 'var(--primary-bg, rgba(37, 99, 235, 0.12))'
        setTimeout(() => { el.style.backgroundColor = '' }, 1500)
      }
    }, 100)
    return () => clearTimeout(timer)
  }, [location.hash, decodedId, tabParam])

  // Lineage state
  const [depth, setDepth] = useState(2)
  const [parentsDepth, setParentsDepth] = useState(2)
  const [childrenDepth, setChildrenDepth] = useState(2)
  const [direction, setDirection] = useState<LineageDirection>('both')
  const [layoutMode, setLayoutMode] = useState<'layered' | 'dag'>(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('dg-lineage-layout') : null
    return stored === 'layered' || stored === 'dag' ? stored : 'dag'
  })
  useEffect(() => {
    window.localStorage.setItem('dg-lineage-layout', layoutMode)
  }, [layoutMode])
  const [showParentSiblings, setShowParentSiblings] = useState(false)
  const [lineageFullscreen, setLineageFullscreen] = useState(false)
  const [typeFilter, toggleType, setTypeMode, clearTypes] = useFilterState()
  const { selected: globalTagSelected, mode: globalTagMode, toggle: toggleTag, setMode: setTagMode, clear: clearTags } = useTagFilterStore()
  const tagFilter: FilterState = useMemo(() => ({ mode: globalTagMode, selected: new Set(globalTagSelected) }), [globalTagSelected, globalTagMode])
  const [folderFilter, toggleFolder, setFolderMode, clearFolders] = useFilterState()
  const [layerFilter, toggleLayer, setLayerMode, clearLayers] = useFilterState()
  const [modelFilter, toggleModel, setModelFilterMode, clearModels] = useFilterState()

  const rawSubgraph = useMemo(() => {
    if (!data || !decodedId) return { nodes: [], edges: [] }
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
  }, [data, decodedId, depth, direction, parentsDepth, childrenDepth, showParentSiblings])

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
    // Models filter: explicit per-node include/exclude.
    // - The focal model is never excluded: losing it on its own page is
    //   confusing, so an exclude-set containing the focal is ignored for it.
    // - Exclude cascades: dropping a node also drops everything downstream
    //   of it. Otherwise excluding an upstream parent leaves orphaned
    //   children dangling without their context, which is rarely useful.
    const effectiveExclude = new Set<string>()
    if (modelFilter.mode === 'exclude') {
      for (const id of modelFilter.selected) {
        for (const d of getDescendants(id, rawSubgraph.edges)) effectiveExclude.add(d)
      }
      effectiveExclude.delete(decodedId)
    }
    const keep = base.nodes.filter(n => {
      if (n.id === decodedId) return true
      if (modelFilter.mode === 'include') return modelFilter.selected.has(n.id)
      return !effectiveExclude.has(n.id)
    })
    const ids = new Set(keep.map(n => n.id))
    return {
      nodes: keep,
      edges: base.edges.filter(e => ids.has(e.source) && ids.has(e.target)),
    }
  }, [rawSubgraph, typeFilter, tagFilter, folderFilter, layerFilter, modelFilter, decodedId])

  const columnLineageCandidateIds = useMemo(
    () => getColumnLineageCandidateIds(filteredSubgraph.nodes, data?.column_lineage),
    [filteredSubgraph, data?.column_lineage],
  )

  const subgraphOptions = useMemo(() => {
    return computeSubgraphOptions(rawSubgraph.nodes)
  }, [rawSubgraph.nodes])

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

  const modelColumnsMap = useMemo(() => {
    if (!data) return {}
    return buildModelColumnsMap(data)
  }, [data])

  // ERD tab: 1-hop subgraph of relationships involving this model. Tab is
  // hidden entirely if the site was generated without `--enable-erd` (in
  // which case `data.relationships` is undefined or empty).
  const erdEnabled = (data?.relationships?.length ?? 0) > 0
  const erdSubgraph = useMemo(
    () => getModelErdSubgraph(decodedId, data?.relationships ?? []),
    [decodedId, data?.relationships],
  )
  const erdSubgraphModels = useMemo<Record<string, DocglowModel>>(() => {
    if (!data) return {}
    const out: Record<string, DocglowModel> = {}
    for (const uid of erdSubgraph.models) {
      const m = data.models[uid]
      if (m) out[uid] = m
    }
    return out
  }, [data, erdSubgraph.models])

  if (!model) {
    return (
      <div className="text-[var(--text-muted)]">
        Model not found: {id ? decodeURIComponent(id) : 'unknown'}
      </div>
    )
  }

  const hasSampleData = Boolean(model.sample_data)
  const hasProfiles = model.columns.some(c => c.profile != null)
  const hasQuestions = (model.questions?.length ?? 0) > 0
  const tabs: { key: string; label: string }[] = [
    { key: 'columns', label: `Columns (${model.columns.length})` },
    { key: 'documentation', label: 'Documentation' },
    ...(hasQuestions ? [{ key: 'questions' as const, label: `Questions (${model.questions!.length})` }] : []),
    ...customDocs.map(doc => ({ key: doc.slug, label: doc.label })),
    { key: 'sql', label: 'SQL' },
    ...(hasProfiles ? [{ key: 'statistics' as const, label: 'Statistics' }] : []),
    ...(hasSampleData ? [{ key: 'data' as const, label: 'Data' }] : []),
    { key: 'lineage', label: 'Lineage' },
    ...(erdEnabled ? [{ key: 'erd' as const, label: 'ERD' }] : []),
    { key: 'tests', label: `Tests (${model.test_results.length})` },
  ]
  const activeCustomDoc = customDocs.find(doc => doc.slug === activeTab)

  const overallTestStatus = (() => {
    if (model.test_results.length === 0) return 'none' as const
    if (model.test_results.some(t => t.status === 'fail' || t.status === 'error')) return 'fail' as const
    if (model.test_results.some(t => t.status === 'warn')) return 'warn' as const
    if (model.test_results.every(t => t.status === 'pass')) return 'pass' as const
    return 'none' as const
  })()

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-2xl font-bold">{model.name}</h1>
          <span className="px-2 py-0.5 text-xs font-medium rounded bg-primary/10 text-primary">
            {materializationLabel(model.materialization)}
          </span>
          <TestBadge status={overallTestStatus} />
        </div>
        <div className="text-sm text-[var(--text-muted)] flex gap-4">
          <span>{formatFqn({ database: model.database, schema: model.schema })}</span>
          <span>{model.path}</span>
        </div>
        {model.tags.length > 0 && (
          <div className="flex gap-1 mt-2">
            {model.tags.map(tag => (
              <span key={tag} className="px-2 py-0.5 text-xs rounded bg-[var(--bg-surface)] border border-[var(--border)]">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Dependencies */}
      {(model.depends_on.length > 0 || model.referenced_by.length > 0) && (
        <div className="mb-6 flex gap-8 text-sm">
          {model.depends_on.length > 0 && (
            <DependencyList
              label="Depends on"
              ids={model.depends_on}
              onNavigate={(type, id) => navigate(`/${type}/${encodeURIComponent(id)}`)}
            />
          )}
          {model.referenced_by.length > 0 && (
            <DependencyList
              label="Referenced by"
              ids={model.referenced_by}
              onNavigate={(type, id) => navigate(`/${type}/${encodeURIComponent(id)}`)}
            />
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-[var(--border)] flex gap-0 mb-4">
        {tabs.map(tab => (
          <button key={tab.key}
                  onClick={() => selectTab(tab.key)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer
                    ${activeTab === tab.key
                      ? 'border-primary text-primary'
                      : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text)]'
                    }`}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'columns' && (
        <ColumnTable
          columns={model.columns}
          columnLineage={getColumnLineage(decodedId)}
          columnDownstream={data?.column_lineage ? buildDownstreamMap(decodedId, data.column_lineage) : undefined}
          modelId={decodedId}
          columnLineageData={data?.column_lineage}
        />
      )}

      {activeTab === 'documentation' && (
        <div data-testid="model-documentation-tab">
          {model.description ? (
            <Markdown content={model.description} className="text-sm" />
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No model description.</p>
          )}
        </div>
      )}

      {activeTab === 'questions' && (
        <QuestionsTab model={model} />
      )}

      {activeCustomDoc && (
        <CustomDocFrame doc={activeCustomDoc} />
      )}

      {activeTab === 'sql' && (
        <div>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setSqlMode('compiled')}
              className={`px-3 py-1 text-xs rounded cursor-pointer ${
                sqlMode === 'compiled'
                  ? 'bg-primary text-white'
                  : 'bg-[var(--bg-surface)] text-[var(--text-muted)]'
              }`}
            >
              Compiled
            </button>
            <button
              onClick={() => setSqlMode('raw')}
              className={`px-3 py-1 text-xs rounded cursor-pointer ${
                sqlMode === 'raw'
                  ? 'bg-primary text-white'
                  : 'bg-[var(--bg-surface)] text-[var(--text-muted)]'
              }`}
            >
              Raw
            </button>
          </div>
          <SqlViewer sql={sqlMode === 'compiled' ? model.compiled_sql : model.raw_sql} />
        </div>
      )}

      {activeTab === 'data' && hasSampleData && model.sample_data && (
        <SampleDataTable data={model.sample_data} />
      )}

      {activeTab === 'statistics' && (
        <StatisticsTab model={model} />
      )}

      {activeTab === 'lineage' && (
        <div className={lineageFullscreen
          ? 'fixed inset-0 z-50 bg-[var(--bg)] flex flex-col'
          : 'flex flex-col'
        }>
          {/* Lineage toolbar */}
          <div className="flex items-center gap-2 mb-2 flex-wrap shrink-0 px-1">
            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--text-muted)]">Depth</label>
              <input
                type="range"
                min={1}
                max={6}
                value={depth}
                onChange={e => {
                  const v = Number(e.target.value)
                  setDepth(v)
                  setParentsDepth(v)
                  setChildrenDepth(v)
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
                onChange={e => setParentsDepth(Number(e.target.value))}
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
                onChange={e => setChildrenDepth(Number(e.target.value))}
                className="w-20 accent-[var(--primary)]"
              />
              <span className="text-xs font-medium w-4 text-center">{childrenDepth}</span>
            </div>

            <div className="h-4 w-px bg-[var(--border)]" />

            {/* Direction toggle */}
            <div className="flex items-center rounded overflow-hidden border border-[var(--border)]">
              {(['upstream', 'both', 'downstream'] as const).map(dir => (
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

            {/* Layered/DAG layout toggle */}
            <div className="flex items-center rounded overflow-hidden border border-[var(--border)]">
              {(['layered', 'dag'] as const).map(m => (
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

            {/* Parent outputs — surfaces siblings of focal (other children of its direct parents) */}
            <label
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer select-none"
              title="Also show siblings — the other models fed by the focal's direct parents"
            >
              <input
                type="checkbox"
                checked={showParentSiblings}
                onChange={e => setShowParentSiblings(e.target.checked)}
                className="accent-[var(--primary)] cursor-pointer"
              />
              Parent outputs
            </label>

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
                  (data?.lineage.layer_config ?? []).find(l => String(l.rank) === rank)?.name
                  ?? `Layer ${rank}`
                }
                optionAccent={(rank) =>
                  (data?.lineage.layer_config ?? []).find(l => String(l.rank) === rank)?.color
                }
              />
            )}
            {rawSubgraph.nodes.length > 1 && (
              <FilterDropdown
                label="Models"
                options={rawSubgraph.nodes.map(n => n.id).sort()}
                filter={modelFilter}
                onToggle={toggleModel}
                onSetMode={setModelFilterMode}
                onClear={clearModels}
                displayLabel={(id) =>
                  rawSubgraph.nodes.find(n => n.id === id)?.name ?? id
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

            <div className="h-4 w-px bg-[var(--border)]" />
            <ColumnExpandControls candidateIds={columnLineageCandidateIds} />

            <span className="text-xs text-[var(--text-muted)] ml-auto">
              {filteredSubgraph.nodes.length} nodes · {filteredSubgraph.edges.length} edges
            </span>

            {/* Fullscreen toggle */}
            <button
              onClick={() => setLineageFullscreen(f => !f)}
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

          {/* Graph area */}
          <div className={lineageFullscreen ? 'flex-1 relative min-h-0' : 'relative'} style={lineageFullscreen ? undefined : { height: 'calc(100vh - 380px)', minHeight: 400 }}>
            <LineageFlow
              nodes={
                layoutMode === 'dag'
                  ? filteredSubgraph.nodes.map(n => ({ ...n, layer: undefined }))
                  : filteredSubgraph.nodes
              }
              edges={filteredSubgraph.edges}
              pinnedIds={new Set([decodedId])}
              layerConfig={layoutMode === 'dag' ? [] : data?.lineage.layer_config}
              onNavigateAway={() => setLineageFullscreen(false)}
              columnLineageData={data?.column_lineage}
              modelColumns={modelColumnsMap}
            />
          </div>
        </div>
      )}

      {activeTab === 'erd' && (
        <div>
          {erdSubgraph.relationships.length === 0 ? (
            <div className="border border-[var(--border)] rounded-lg p-6 text-sm text-[var(--text-muted)]">
              <p>This model has no declared relationships.</p>
              <p className="mt-2 text-xs">
                Add a <code className="px-1 py-0.5 rounded bg-[var(--bg-surface)]">relationships</code> test in
                {' '}<code className="px-1 py-0.5 rounded bg-[var(--bg-surface)]">schema.yml</code> or use
                {' '}<code className="px-1 py-0.5 rounded bg-[var(--bg-surface)]">meta.docglow.relationships</code>
                {' '}to declare one.
              </p>
            </div>
          ) : (
            <div
              className="border border-[var(--border)] rounded-lg overflow-hidden"
              style={{ height: 'calc(100vh - 380px)', minHeight: 400 }}
            >
              <ErdCanvas
                mode="subgraph"
                models={erdSubgraphModels}
                relationships={erdSubgraph.relationships}
              />
            </div>
          )}
        </div>
      )}

      {activeTab === 'tests' && (
        <div className="border border-[var(--border)] rounded-lg overflow-hidden">
          {model.test_results.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">No tests defined for this model.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-[var(--bg-surface)]">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Test</th>
                  <th className="text-left px-4 py-2 font-medium">Type</th>
                  <th className="text-left px-4 py-2 font-medium">Column</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-right px-4 py-2 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {model.test_results.map((test, i) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    <td className="px-4 py-2 font-mono text-xs">{test.test_name}</td>
                    <td className="px-4 py-2">{test.test_type}</td>
                    <td className="px-4 py-2">{test.column_name ?? '—'}</td>
                    <td className="px-4 py-2">
                      <TestBadge status={test.status} />
                    </td>
                    <td className="px-4 py-2 text-right text-[var(--text-muted)]">
                      {(test.execution_time * 1000).toFixed(0)}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
