import { useState } from 'react'
import { SqlViewer } from '../models/SqlViewer'
import { TestBadge } from './TestBadge'
import type { TestResult } from '../../types'

interface TestsTabProps {
  testResults: readonly TestResult[]
}

function testHasSql(test: TestResult): boolean {
  return Boolean(test.compiled_sql?.trim() || test.raw_sql?.trim())
}

function TestSqlPanel({ test }: { test: TestResult }) {
  const displaySql = test.compiled_sql || test.raw_sql || ''
  const sqlLabel = test.compiled_sql ? 'Test SQL (compiled)' : 'Test SQL (source)'

  if (!displaySql) {
    return (
      <div className="px-4 py-3 text-sm text-[var(--text-muted)]" data-testid="test-sql-empty">
        No SQL available for this test.
      </div>
    )
  }

  return (
    <div className="px-4 py-3 bg-[var(--bg)] border-t border-[var(--border)]" data-testid="test-sql-panel">
      <div className="text-xs font-medium text-[var(--text-muted)] mb-2">{sqlLabel}</div>
      {test.message && test.status !== 'pass' && (
        <pre className="mb-3 overflow-x-auto whitespace-pre-wrap text-xs text-[var(--text-muted)]">
          {test.message}
        </pre>
      )}
      <SqlViewer sql={displaySql} />
    </div>
  )
}

export function TestsTab({ testResults }: TestsTabProps) {
  const [expandedTest, setExpandedTest] = useState<string | null>(null)

  if (testResults.length === 0) {
    return (
      <div className="p-4 text-sm text-[var(--text-muted)]">No tests defined for this model.</div>
    )
  }

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden" data-testid="model-tests-tab">
      <table className="w-full text-sm">
        <thead className="bg-[var(--bg-surface)]">
          <tr>
            <th className="text-left px-4 py-2 font-medium w-8" aria-hidden />
            <th className="text-left px-4 py-2 font-medium">Test</th>
            <th className="text-left px-4 py-2 font-medium">Type</th>
            <th className="text-left px-4 py-2 font-medium">Column</th>
            <th className="text-left px-4 py-2 font-medium">Status</th>
            <th className="text-right px-4 py-2 font-medium">Time</th>
          </tr>
        </thead>
        <tbody>
          {testResults.map((test) => {
            const rowKey = test.test_unique_id || test.test_name
            const isExpanded = expandedTest === rowKey
            const hasSql = testHasSql(test)
            const isClickable = hasSql

            return (
              <tr key={rowKey} className="border-t border-[var(--border)] align-top">
                <td colSpan={6} className="p-0">
                  <button
                    type="button"
                    disabled={!isClickable}
                    onClick={() => {
                      if (!isClickable) return
                      setExpandedTest(isExpanded ? null : rowKey)
                    }}
                    className={`w-full text-left ${isClickable ? 'cursor-pointer hover:bg-[var(--bg-surface)]' : 'cursor-default'}`}
                    data-testid={`test-row-${test.test_name}`}
                    aria-expanded={isClickable ? isExpanded : undefined}
                  >
                    <div className="grid grid-cols-[2rem_1fr_auto_auto_auto_auto] items-center">
                      <span className="px-2 py-2 text-[var(--text-muted)]">
                        {hasSql && (
                          <svg
                            width={14}
                            height={14}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          >
                            <path d="M9 18l6-6-6-6" />
                          </svg>
                        )}
                      </span>
                      <span className="px-4 py-2 font-mono text-xs">{test.test_name}</span>
                      <span className="px-4 py-2">{test.test_type || 'singular'}</span>
                      <span className="px-4 py-2">{test.column_name ?? '—'}</span>
                      <span className="px-4 py-2">
                        <TestBadge status={test.status} />
                      </span>
                      <span className="px-4 py-2 text-right text-[var(--text-muted)]">
                        {(test.execution_time * 1000).toFixed(0)}ms
                      </span>
                    </div>
                  </button>
                  {isExpanded && <TestSqlPanel test={test} />}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
