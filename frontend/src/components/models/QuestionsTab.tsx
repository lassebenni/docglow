import { Markdown } from '../Markdown'
import type { CustomDoc, DocglowModel, ModelQuestion } from '../../types'

interface QuestionsTabProps {
  model: DocglowModel
}

interface ResolvedProof {
  doc: CustomDoc
  anchor: string
}

/**
 * Resolve a proof reference of the form "<slug>#<anchor>" (or "self#<anchor>",
 * an alias for the model's own guide doc) against the model's custom_docs.
 * Returns null when the slug doesn't match an attached doc — the question
 * still renders, just without a proof link.
 */
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

/**
 * Native Questions tab: the business questions a model answers, authored in
 * dbt model YAML under `meta.docglow.questions` and attached to the payload
 * at site-generation time (see docglow.generator.questions).
 */
export function QuestionsTab({ model }: QuestionsTabProps) {
  const questions: readonly ModelQuestion[] = model.questions ?? []
  const customDocs: readonly CustomDoc[] = model.custom_docs ?? []

  if (questions.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]" data-testid="questions-empty">
        No questions declared for this model.
      </p>
    )
  }

  return (
    <div data-testid="model-questions-tab" className="max-w-3xl">
      <p className="text-sm text-[var(--text-muted)] mb-4">
        Questions this model is designed to answer, with the short answer and a
        pointer to the evidence.
      </p>
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
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
