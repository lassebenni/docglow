import { describe, it, expect } from 'vitest'
import { getProjectKey, DEFAULT_PROJECT_KEY } from '../utils/erdProjectKey'
import type { DocglowData } from '../types'

/**
 * Build a minimal DocglowData with just the bits getProjectKey reads.
 * Casts via `unknown` because the full payload is large; the helper only
 * inspects `metadata.project_name`.
 */
function fakeData(projectName: string | undefined): DocglowData {
  const metadata = projectName === undefined ? {} : { project_name: projectName }
  return { metadata } as unknown as DocglowData
}

describe('getProjectKey', () => {
  it('returns the project_name when set', () => {
    expect(getProjectKey(fakeData('jaffle_shop'))).toBe('jaffle_shop')
  })

  it('returns DEFAULT_PROJECT_KEY when data is null', () => {
    expect(getProjectKey(null)).toBe(DEFAULT_PROJECT_KEY)
  })

  it('returns DEFAULT_PROJECT_KEY when data is undefined', () => {
    expect(getProjectKey(undefined)).toBe(DEFAULT_PROJECT_KEY)
  })

  it('returns DEFAULT_PROJECT_KEY when project_name is missing', () => {
    expect(getProjectKey(fakeData(undefined))).toBe(DEFAULT_PROJECT_KEY)
  })

  it('returns DEFAULT_PROJECT_KEY when project_name is the empty string', () => {
    expect(getProjectKey(fakeData(''))).toBe(DEFAULT_PROJECT_KEY)
  })

  it('preserves casing/whitespace in the project_name', () => {
    expect(getProjectKey(fakeData('My Cool Project'))).toBe('My Cool Project')
  })
})
