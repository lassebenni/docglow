import { describe, expect, it } from 'vitest'

type TopValue = { value: string; frequency: number }

function sortedValueFrequencies(topValues: TopValue[]) {
  return topValues
    .map(entry => ({ value: Number(entry.value), count: entry.frequency }))
    .filter(entry => Number.isFinite(entry.value))
    .sort((a, b) => a.value - b.value)
}

function valueAtPercentile(entries: { value: number; count: number }[], percentile: number) {
  const total = entries.reduce((sum, entry) => sum + entry.count, 0)
  const target = total * percentile
  let cumulative = 0
  for (const entry of entries) {
    cumulative += entry.count
    if (cumulative >= target) return entry
  }
  return entries[entries.length - 1]
}

describe('discrete quantile record counts', () => {
  it('uses exact value frequency at percentile, not bin totals', () => {
    const topValues: TopValue[] = [
      { value: '0', frequency: 2_650_000 },
      { value: '-1', frequency: 42_000 },
      { value: '-2', frequency: 8_500 },
      { value: '-18', frequency: 17 },
    ]

    const entries = sortedValueFrequencies(topValues)
    const q1 = valueAtPercentile(entries, 0.25)
    const median = valueAtPercentile(entries, 0.5)
    const q3 = valueAtPercentile(entries, 0.75)

    expect(q1.value).toBe(0)
    expect(q1.count).toBe(2_650_000)
    expect(median.value).toBe(0)
    expect(median.count).toBe(2_650_000)
    expect(q3.value).toBe(0)
    expect(q3.count).toBe(2_650_000)
  })
})
