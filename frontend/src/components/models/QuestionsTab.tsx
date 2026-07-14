import { Markdown } from '../Markdown'
import { SqlViewer } from './SqlViewer'
import { TestBadge } from '../tests/TestBadge'
import { useProjectStore } from '../../stores/projectStore'
import type { CustomDoc, DocglowModel, ModelQuestion, QuestionVerification } from '../../types'

interface QuestionsTabProps {
  model: DocglowModel
}

interface ResolvedProof {
  doc: CustomDoc
  anchor: string
}

function resolveProof(proof: string, customDocs: readonly CustomDoc[]): ResolvedProof | null {
  const hashIdx = proof.indexOf('#')
  const slugRaw = hashIdx === -1 ? proof : proof.slice(0, hashIdx)
  const anchor = hashIdx === -1 ? '' : proof.slice(hashIdx + 1)
  const slug = slugRaw === 'self' || slugRaw === '' ? 'guide' : slugRaw
  const doc = customDocs.find(d => d.slug === slug)
  if (!doc) return null
  return { doc, anchor }
}

function ProofLink({ proof, customDocs }: { proof: string; customDocs: readonly CustomDoc[] }) {
  const resolved = resolveProof(proof, customDocs)
  if (!resolved) {
    return (
      <span className="text-xs text-[var(--text-muted)]" data-testid="question-proof-unresolved">
        Proof: {proof}
      </span>
    )
  }
  const { doc, anchor } = resolved
  const href = anchor ? `${doc.url}#${anchor}` : doc.url
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-testid="question-proof-link"
      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
      title={`Open ${doc.label}${anchor ? ` at #${anchor}` : ''} in a new tab`}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
      </svg>
      {doc.label}{anchor ? ` · #${anchor}` : ''}
    </a>
  )
}

const VERIFY_LABEL: Record<string, string> = {
  pass: 'verified',
  fail: 'failing',
  error: 'failing',
  warn: 'warning',
  not_run: 'not run',
  misconfigured: 'misconfigured',
}

function formatVerifiedAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function QuestionVerificationPanel({ verification }: { verification: QuestionVerification }) {
  const label = VERIFY_LABEL[verification.status] ?? verification.status
  const verifiedAt = formatVerifiedAt(verification.verified_at)
  const timeMs = verification.execution_time > 0
    ? `${(verification.execution_time * 1000).toFixed(0)}ms`
    : null
  const displaySql = verification.compiled_sql || verification.raw_sql || ''
  const sqlLabel = verification.compiled_sql ? 'Test SQL (compiled)' : 'Test SQL (source)'

  return (
    <div
      className="mt-3 rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2"
      data-testid="question-verification-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          dbt verification
        </span>
        <TestBadge status={verification.status === 'misconfigured' ? 'error' : verification.status} label={label} />
      </div>
      <div className="mt-1 font-mono text-xs text-[var(--text)]">{verification.test_name}</div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
        {verification.failures > 0 && (
          <span>{verification.failures} failure{verification.failures === 1 ? '' : 's'}</span>
        )}
        {timeMs && <span>{timeMs}</span>}
        {verifiedAt && <span>run {verifiedAt}</span>}
        {verification.test_type && <span>{verification.test_type}</span>}
      </div>
      {verification.message && verification.status !== 'pass' && (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-[var(--text-muted)]">
          {verification.message}
        </pre>
      )}
      {displaySql && (
        <details className="mt-2 group" data-testid="question-verification-sql">
          <summary className="cursor-pointer list-none text-xs font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-1">
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="transition-transform group-open:rotate-90"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
              {sqlLabel}
            </span>
          </summary>
          <div className="mt-2">
            <SqlViewer sql={displaySql} />
          </div>
        </details>
      )}
    </div>
  )
}

export function QuestionsTab({ model }: QuestionsTabProps) {
  const { data } = useProjectStore()
  const questions: readonly ModelQuestion[] = model.questions ?? []
  const customDocs: readonly CustomDoc[] = model.custom_docs ?? []
  const testRunAt = formatVerifiedAt(data?.metadata?.test_run_at ?? null)

  if (questions.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]" data-testid="questions-empty">
        No questions declared for this model.
      </p>
    )
  }

  return (
    <div data-testid="model-questions-tab" className="max-w-3xl">
      <p className="text-sm text-[var(--text-muted)] mb-1">
        Questions this model is designed to answer, with the short answer and a
        pointer to the evidence.
      </p>
      {testRunAt && (
        <p className="text-xs text-[var(--text-muted)] mb-4" data-testid="questions-test-run-at">
          Verification results from dbt run {testRunAt}.
        </p>
      )}
      {!testRunAt && questions.some(q => q.verified_by) && (
        <p className="text-xs text-amber-700 mb-4" data-testid="questions-test-run-missing">
          No run_results bundled — verified questions show as not run until the site is regenerated after dbt test.
        </p>
      )}
      <ol className="space-y-4">
        {questions.map((q, i) => (
          <li
            key={`${i}-${q.question}`}
            className="rounded border border-[var(--border)] bg-[var(--bg-surface)] p-4"
            data-testid="question-item"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-semibold text-[var(--text-muted)] tabular-nums">
                {i + 1}.
              </span>
              <span className="text-sm font-semibold">{q.question}</span>
            </div>
            <div className="mt-2 pl-6">
              <Markdown content={q.answer} className="text-sm" />
              {q.proof && (
                <div className="mt-2">
                  <ProofLink proof={q.proof} customDocs={customDocs} />
                </div>
              )}
              {q.verification && (
                <QuestionVerificationPanel verification={q.verification} />
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
