import { useMemo, useState, useRef } from 'react'
import type { DocglowModel, TemporalBin } from '../../types'
import { formatNumber, formatPercent } from '../../utils/formatting'
import { NullBar, TopValuesChart } from './ColumnTable'

interface StatisticsTabProps {
  model: DocglowModel
}

function estimateQuantiles(bins: { low: number; high: number; count: number }[], min: number, max: number) {
  const total = bins.reduce((acc, b) => acc + b.count, 0)
  if (total === 0 || max <= min) {
    return { min, q1: min, median: min, q3: min, max }
  }

  const getVal = (targetCount: number) => {
    let cum = 0
    for (const bin of bins) {
      if (cum + bin.count >= targetCount) {
        const fraction = bin.count > 0 ? (targetCount - cum) / bin.count : 0
        return bin.low + fraction * (bin.high - bin.low)
      }
      cum += bin.count
    }
    return max
  }

  return {
    min,
    q1: getVal(total * 0.25),
    median: getVal(total * 0.50),
    q3: getVal(total * 0.75),
    max
  }
}

interface BoxWhiskerPlotProps {
  bins: { low: number; high: number; count: number }[]
  min: number
  max: number
}

function BoxWhiskerPlot({ bins, min, max }: BoxWhiskerPlotProps) {
  const q = estimateQuantiles(bins, min, max)

  const mapX = (val: number) => {
    const range = max - min
    if (range === 0) return 500
    return 15 + ((val - min) / range) * 970
  }

  const xMin = mapX(q.min)
  const xQ1 = mapX(q.q1)
  const xMedian = mapX(q.median)
  const xQ3 = mapX(q.q3)
  const xMax = mapX(q.max)

  const formatVal = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 })

  return (
    <div className="space-y-2">
      <div className="relative h-11 border border-[var(--border)] bg-[var(--bg)]/30 rounded-md p-1">
        <svg className="w-full h-full overflow-visible" viewBox="0 0 1000 44" preserveAspectRatio="none">
          {/* Whiskers */}
          <line x1={xMin} y1={22} x2={xQ1} y2={22} stroke="currentColor" className="text-[var(--text-muted)] opacity-60" strokeWidth="1.5" strokeDasharray="4,4" />
          <line x1={xQ3} y1={22} x2={xMax} y2={22} stroke="currentColor" className="text-[var(--text-muted)] opacity-60" strokeWidth="1.5" strokeDasharray="4,4" />

          {/* Min & Max End Lines */}
          <line x1={xMin} y1={12} x2={xMin} y2={32} stroke="currentColor" className="text-[var(--text-muted)]" strokeWidth="2.5" />
          <line x1={xMax} y1={12} x2={xMax} y2={32} stroke="currentColor" className="text-[var(--text-muted)]" strokeWidth="2.5" />

          {/* Box (IQR) */}
          <rect x={xQ1} y={8} width={Math.max(xQ3 - xQ1, 1)} height={28} rx={2} className="fill-primary/10 stroke-primary stroke-[1.5]" />

          {/* Median */}
          <line x1={xMedian} y1={8} x2={xMedian} y2={36} className="stroke-primary stroke-[2.5]" />
          <circle cx={xMedian} cy={22} r={3.5} className="fill-primary" />
        </svg>
      </div>

      <div className="flex justify-between items-center text-[10px] text-[var(--text-muted)] px-1 font-mono pt-1 select-all">
        <span>Min: {formatVal(q.min)}</span>
        <span>Q1: {formatVal(q.q1)}</span>
        <span className="text-primary font-semibold">Median: {formatVal(q.median)}</span>
        <span>Q3: {formatVal(q.q3)}</span>
        <span>Max: {formatVal(q.max)}</span>
      </div>
    </div>
  )
}

export function StatisticsTab({ model }: StatisticsTabProps) {
  const [hoveredBins, setHoveredBins] = useState<Record<string, { bin: TemporalBin; x: number; y: number } | null>>({})
  const chartScrollRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Extract columns with profile information
  const profiledColumns = useMemo(() => {
    return model.columns.filter(c => c.profile != null)
  }, [model.columns])

  const dateColumns = useMemo(() => {
    return model.columns.filter(c => c.profile?.temporal_distribution && c.profile.temporal_distribution.length > 0)
  }, [model.columns])

  const numericColumns = useMemo(() => {
    return model.columns.filter(c => c.profile?.histogram && c.profile.histogram.length > 0)
  }, [model.columns])

  const categoricalColumns = useMemo(() => {
    return model.columns.filter(c => c.profile?.top_values && c.profile.top_values.length > 0)
  }, [model.columns])

  // Compute model-level metrics
  const summaryMetrics = useMemo(() => {
    const totalCols = model.columns.length
    const profiledCols = profiledColumns.length
    
    let totalNullCount = 0
    let totalRows = 0
    
    profiledColumns.forEach(c => {
      if (c.profile) {
        totalNullCount += c.profile.null_count
        totalRows = Math.max(totalRows, c.profile.row_count)
      }
    })

    const avgNullRate = profiledCols > 0 ? (totalNullCount / (totalRows * profiledCols)) : 0

    return {
      totalCols,
      profiledCols,
      avgNullRate,
      rowCount: model.catalog_stats.row_count ?? totalRows
    }
  }, [model.columns, profiledColumns, model.catalog_stats])

  // Compute temporal gaps (contiguous missing dates)
  const temporalGaps = useMemo(() => {
    const gapsMap: Record<string, { start: string; end: string; days: number }[]> = {}

    dateColumns.forEach(col => {
      const dist = col.profile!.temporal_distribution!
      if (dist.length < 2) return

      const sortedDist = [...dist].sort((a, b) => a.date.localeCompare(b.date))
      const dateSet = new Set(sortedDist.filter(d => d.count > 0).map(d => d.date))
      
      const minDate = new Date(sortedDist[0].date)
      const maxDate = new Date(sortedDist[sortedDist.length - 1].date)

      const gaps: { start: string; end: string; days: number }[] = []
      let gapStart: Date | null = null
      let cursor = new Date(minDate)

      while (cursor <= maxDate) {
        const iso = cursor.toISOString().split('T')[0]
        const hasData = dateSet.has(iso)

        if (!hasData) {
          if (gapStart === null) {
            gapStart = new Date(cursor)
          }
        } else {
          if (gapStart !== null) {
            const gapEnd = new Date(cursor)
            gapEnd.setDate(gapEnd.getDate() - 1)
            
            const diffTime = Math.abs(gapEnd.getTime() - gapStart.getTime())
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1
            
            gaps.push({
              start: gapStart.toISOString().split('T')[0],
              end: gapEnd.toISOString().split('T')[0],
              days: diffDays
            })
            gapStart = null
          }
        }
        cursor.setDate(cursor.getDate() + 1)
      }

      // Handle trailing gap if maxDate itself was missing
      if (gapStart !== null) {
        const diffTime = Math.abs(maxDate.getTime() - gapStart.getTime())
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1
        gaps.push({
          start: gapStart.toISOString().split('T')[0],
          end: maxDate.toISOString().split('T')[0],
          days: diffDays
        })
      }

      if (gaps.length > 0) {
        gapsMap[col.name] = gaps
      }
    })

    return gapsMap
  }, [dateColumns])

  return (
    <div className="space-y-6">
      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg">
          <div className="text-xs text-[var(--text-muted)] font-medium mb-1">Total Rows</div>
          <div className="text-2xl font-bold">{summaryMetrics.rowCount ? formatNumber(summaryMetrics.rowCount) : '—'}</div>
          {model.catalog_stats.bytes && (
            <div className="text-xs text-[var(--text-muted)] mt-1">
              {(model.catalog_stats.bytes / (1024 * 1024)).toFixed(1)} MB on disk
            </div>
          )}
        </div>
        <div className="p-4 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg">
          <div className="text-xs text-[var(--text-muted)] font-medium mb-1">Columns</div>
          <div className="text-2xl font-bold">{summaryMetrics.totalCols}</div>
          <div className="text-xs text-[var(--text-muted)] mt-1">
            {summaryMetrics.profiledCols} profiled ({formatPercent(summaryMetrics.profiledCols / summaryMetrics.totalCols)})
          </div>
        </div>
        <div className="p-4 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg">
          <div className="text-xs text-[var(--text-muted)] font-medium mb-1">Avg. Null Rate</div>
          <div className="text-2xl font-bold">{formatPercent(summaryMetrics.avgNullRate)}</div>
          <div className="text-xs text-[var(--text-muted)] mt-1">Across all profiled columns</div>
        </div>
        <div className="p-4 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg">
          <div className="text-xs text-[var(--text-muted)] font-medium mb-1">Temporal Columns</div>
          <div className="text-2xl font-bold">{dateColumns.length}</div>
          <div className="text-xs text-[var(--text-muted)] mt-1">
            Available for timeline analysis
          </div>
        </div>
      </div>

      {/* Date Timeline & Gap Analysis */}
      {dateColumns.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold border-b border-[var(--border)] pb-2">Temporal Record Gaps</h2>
          <div className="grid grid-cols-1 gap-6">
            {dateColumns.map(col => {
              const dist = col.profile!.temporal_distribution!
              const gaps = temporalGaps[col.name] || []
              
              // Custom mini SVG timeline calculations
              const maxCount = Math.max(...dist.map((d: TemporalBin) => d.count))
              
              return (
                <div key={col.name} className="border border-[var(--border)] bg-[var(--bg-surface)] rounded-lg p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-base flex items-center gap-2">
                        <span className="font-mono text-primary">{col.name}</span>
                        <span className="text-xs font-normal text-[var(--text-muted)] bg-[var(--bg)] px-2 py-0.5 rounded border border-[var(--border)]">
                          {col.data_type}
                        </span>
                      </h3>
                      <p className="text-xs text-[var(--text-muted)] mt-1">
                        Timeline from <span className="font-mono font-semibold">{col.profile?.min}</span> to <span className="font-mono font-semibold">{col.profile?.max}</span>
                      </p>
                    </div>

                    {gaps.length > 0 ? (
                      <span className="self-start sm:self-center px-2 py-1 rounded text-xs font-semibold bg-danger/10 text-danger border border-danger/20">
                        {gaps.length} missing period{gaps.length > 1 ? 's' : ''} ({gaps.reduce((acc, g) => acc + g.days, 0)} days total)
                      </span>
                    ) : (
                      <span className="self-start sm:self-center px-2 py-1 rounded text-xs font-semibold bg-success/10 text-success border border-success/20">
                        Continuous Sequence
                      </span>
                    )}
                  </div>

                  {/* SVG Density Bar Chart */}
                  <div className="bg-[var(--bg)] border border-[var(--border)] rounded p-4 overflow-hidden">
                    <div className="text-xs text-[var(--text-muted)] flex justify-between mb-2">
                      <span>{col.profile?.min}</span>
                      <span>Daily records distribution</span>
                      <span>{col.profile?.max}</span>
                    </div>
                    <div 
                      ref={el => { chartScrollRefs.current[col.name] = el }}
                      className="overflow-x-auto pb-2 scrollbar-thin relative"
                    >
                      <div className="flex flex-col min-w-full w-max gap-1">
                        {/* Bars row */}
                        <div className="h-16 flex items-end gap-[2px] border-b border-[var(--border)] pb-px relative mt-8">
                          {dist.map((bin: TemporalBin, idx: number) => {
                            const heightPct = maxCount > 0 ? (bin.count / maxCount) * 100 : 0
                            const isZero = bin.count === 0
                            return (
                              <div
                                key={idx}
                                className={`shrink-0 transition-all rounded-t-[1px] cursor-pointer ${
                                  isZero 
                                    ? 'bg-danger/20 hover:bg-danger/40' 
                                    : 'bg-primary/50 hover:bg-primary/80'
                                }`}
                                style={{ height: `${Math.max(heightPct, isZero ? 15 : 0)}%`, width: 4 }}
                                onMouseEnter={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  const parentRect = e.currentTarget.parentElement?.getBoundingClientRect()
                                  if (parentRect) {
                                    setHoveredBins(prev => ({
                                      ...prev,
                                      [col.name]: {
                                        bin,
                                        x: rect.left - parentRect.left + (rect.width / 2),
                                        y: -32
                                      }
                                    }))
                                  }
                                }}
                                onMouseLeave={() => {
                                  setHoveredBins(prev => {
                                    if (prev[col.name]?.bin.date === bin.date) {
                                      return {
                                        ...prev,
                                        [col.name]: null
                                      }
                                    }
                                    return prev
                                  })
                                }}
                              />
                            )
                          })}
                          
                          {/* Floating Tooltip */}
                          {hoveredBins[col.name] && (
                            <div 
                              className="absolute bg-[var(--bg-surface)] border border-[var(--border)] shadow-lg rounded px-2 py-1 text-xs font-mono z-20 pointer-events-none transform -translate-x-1/2 whitespace-nowrap"
                              style={{ 
                                left: hoveredBins[col.name]!.x, 
                                top: hoveredBins[col.name]!.y 
                              }}
                            >
                              <span className="text-primary font-semibold">{hoveredBins[col.name]!.bin.date}</span>
                              <span className="mx-1 text-[var(--text-muted)]">|</span>
                              <span>{formatNumber(hoveredBins[col.name]!.bin.count)} rows</span>
                            </div>
                          )}
                        </div>

                        {/* Ticks & Dates x-axis row */}
                        <div className="h-7 flex gap-[2px] relative pt-0.5 select-none">
                          {(() => {
                            const showWeekly = dist.length < 45
                            return dist.map((bin: TemporalBin, idx: number) => {
                              const isTick = showWeekly 
                                ? (idx % 7 === 0) 
                                : bin.date.endsWith("-01")

                              if (!isTick) {
                                return <div key={idx} style={{ width: 4 }} className="shrink-0" />
                              }

                              let label = ""
                              if (showWeekly) {
                                label = bin.date.slice(5) // "MM-DD"
                              } else {
                                const isJan = bin.date.endsWith("-01-01")
                                const dateParts = bin.date.split("-")
                                const yearShort = dateParts[0].slice(2)
                                const monthIndex = parseInt(dateParts[1], 10) - 1
                                const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
                                label = isJan ? `${dateParts[0]}` : `${monthNames[monthIndex]} '${yearShort}`
                              }

                              const isFirst = idx === 0
                              const isLast = idx === dist.length - 1
                              const translateClass = isFirst 
                                ? "translate-x-0" 
                                : isLast 
                                  ? "-translate-x-[calc(100%-4px)]" 
                                  : "-translate-x-1/2"

                              return (
                                <div key={idx} className="shrink-0 flex flex-col relative" style={{ width: 4 }}>
                                  {/* Small vertical tick line */}
                                  <div className="absolute top-[-3px] left-[1px] w-[1px] h-[5px] bg-[var(--border-hover)]" />
                                  {/* Label */}
                                  <div className={`absolute top-[4px] left-[2px] text-[9px] text-[var(--text-muted)] whitespace-nowrap font-mono transform ${translateClass}`}>
                                    {label}
                                  </div>
                                </div>
                              )
                            })
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Detailed gaps list */}
                  {gaps.length > 0 && (
                    <div className="border border-danger/20 bg-danger/5 rounded-lg p-4 space-y-3">
                      <div className="text-sm font-semibold text-danger flex items-center gap-1.5">
                        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        Missing Temporal Date Intervals (Sorted by Gaps Descending):
                      </div>
                      <div className="border border-[var(--border)] rounded-md overflow-hidden max-h-44 overflow-y-auto scrollbar-thin">
                        {(() => {
                          const sortedGaps = [...gaps].sort((a, b) => b.days - a.days)
                          return (
                            <table className="min-w-full divide-y divide-[var(--border)] text-xs text-left">
                              <thead className="bg-[var(--bg)] sticky top-0 z-10 border-b border-[var(--border)]">
                                <tr>
                                  <th scope="col" className="px-4 py-2 font-semibold text-[var(--text-muted)]">Missing Interval</th>
                                  <th scope="col" className="px-4 py-2 font-semibold text-[var(--text-muted)] text-right">Missing Days</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-[var(--border)] bg-[var(--bg-surface)]">
                                {sortedGaps.map((gap, i) => (
                                  <tr 
                                    key={i} 
                                    className="hover:bg-primary/5 hover:text-primary transition-colors cursor-pointer"
                                    onClick={() => {
                                      const binIndex = dist.findIndex(b => b.date === gap.start)
                                      if (binIndex !== -1) {
                                        const container = chartScrollRefs.current[col.name]
                                        if (container) {
                                          const barOffsetLeft = binIndex * 6
                                          const targetScrollLeft = barOffsetLeft - (container.clientWidth / 2) + 2
                                          container.scrollTo({ left: targetScrollLeft, behavior: 'smooth' })
                                          
                                          // Focus and trigger the tooltip at the clicked date
                                          setHoveredBins(prev => ({
                                            ...prev,
                                            [col.name]: {
                                              bin: dist[binIndex],
                                              x: barOffsetLeft + 2,
                                              y: -32
                                            }
                                          }))
                                        }
                                      }
                                    }}
                                  >
                                    <td className="px-4 py-2 font-mono text-[var(--text)]">
                                      {gap.start === gap.end ? gap.start : `${gap.start} → ${gap.end}`}
                                    </td>
                                    <td className="px-4 py-2 text-right">
                                      <span className="font-bold text-danger bg-danger/10 px-1.5 py-0.5 rounded text-[10px]">
                                        {gap.days} day{gap.days > 1 ? 's' : ''}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Grid of Profile Histograms & Top Values */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {/* Numerical Histograms */}
        {numericColumns.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold border-b border-[var(--border)] pb-2">Value Distributions (Numeric)</h2>
            <div className="grid grid-cols-1 gap-4">
              {numericColumns.map(col => (
                <div key={col.name} className="border border-[var(--border)] bg-[var(--bg-surface)] rounded-lg p-4 space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-mono font-medium text-sm text-primary">{col.name}</span>
                    <span className="text-xs text-[var(--text-muted)] font-mono">
                      min: {col.profile?.min} · max: {col.profile?.max}
                    </span>
                  </div>
                  <div className="pt-2">
                    <BoxWhiskerPlot 
                      bins={col.profile!.histogram!} 
                      min={Number(col.profile!.min)} 
                      max={Number(col.profile!.max)} 
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Categorical Top Values */}
        {categoricalColumns.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold border-b border-[var(--border)] pb-2">Top Values (Categorical / Low-cardinality)</h2>
            <div className="grid grid-cols-1 gap-4">
              {categoricalColumns.map(col => (
                <div key={col.name} className="border border-[var(--border)] bg-[var(--bg-surface)] rounded-lg p-4 space-y-2">
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-mono font-medium text-sm text-primary">{col.name}</span>
                    <span className="text-xs text-[var(--text-muted)]">
                      {formatNumber(col.profile!.distinct_count)} distinct values
                    </span>
                  </div>
                  <TopValuesChart values={col.profile!.top_values!} rowCount={col.profile!.row_count} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Grid of general stats */}
      <div className="space-y-4 mt-6">
        <h2 className="text-lg font-semibold border-b border-[var(--border)] pb-2">Column Completeness</h2>
        <div className="border border-[var(--border)] rounded-lg overflow-hidden bg-[var(--bg-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg)] text-[var(--text-muted)] border-b border-[var(--border)]">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Column</th>
                <th className="text-left px-4 py-2 font-medium">Type</th>
                <th className="text-left px-4 py-2 font-medium">Null Rate</th>
                <th className="text-right px-4 py-2 font-medium">Distinct Count</th>
              </tr>
            </thead>
            <tbody>
              {profiledColumns.map(col => (
                <tr key={col.name} className="border-t border-[var(--border)] hover:bg-[var(--bg)]/5">
                  <td className="px-4 py-2.5 font-mono text-xs text-primary">{col.name}</td>
                  <td className="px-4 py-2.5 text-xs text-[var(--text-muted)]">{col.data_type}</td>
                  <td className="px-4 py-2.5">
                    <NullBar rate={col.profile!.null_rate} />
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {formatNumber(col.profile!.distinct_count)}
                    {col.profile!.is_unique && (
                      <span className="ml-1 text-[10px] text-success font-semibold bg-success/10 px-1 rounded">unique</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
