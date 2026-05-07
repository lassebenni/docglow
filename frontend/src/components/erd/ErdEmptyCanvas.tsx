/**
 * ErdEmptyCanvas — replaces the canvas itself when the project has no
 * relationships at all (origin requirements §5.9).
 *
 * Shows two side-by-side YAML examples — one for a `relationships` test, one
 * for a `meta.docglow.relationships` block — plus a docs link. The headline
 * matches the spec exactly: "no relationships to map" (lowercase, since we
 * lean into a tighter editorial voice on this page).
 */

const DOCS_URL = 'https://docs.docglow.com/configuration/erd'

const RELATIONSHIPS_TEST_YAML = [
  'columns:',
  '  - name: customer_id',
  '    tests:',
  '      - relationships:',
  "          to: ref('customers')",
  '          field: customer_id',
].join('\n')

const META_DOCGLOW_YAML = [
  'columns:',
  '  - name: customer_id',
  '    meta:',
  '      docglow:',
  '        relationships:',
  '          - to: customers',
  '            field: customer_id',
  '            kind: one_to_many',
].join('\n')

interface YamlCardProps {
  readonly label: string
  readonly snippet: string
  readonly testId: string
}

function YamlCard({ label, snippet, testId }: YamlCardProps) {
  return (
    <div className="flex flex-col" data-testid={testId}>
      <div
        className="mb-1.5"
        style={{
          color: 'var(--text-muted)',
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          fontSize: 10,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <pre
        className="px-3 py-2 text-xs text-left rounded border whitespace-pre overflow-x-auto"
        style={{
          background: 'var(--bg-surface)',
          borderColor: 'var(--border)',
          color: 'var(--text)',
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
          lineHeight: 1.5,
          margin: 0,
        }}
      >
        {snippet}
      </pre>
    </div>
  )
}

export function ErdEmptyCanvas() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center px-6 py-10"
      data-testid="erd-empty-canvas"
    >
      <div className="flex flex-col gap-5 w-full" style={{ maxWidth: 720 }}>
        <div className="flex flex-col gap-2 text-left">
          <h2
            className="text-xl font-semibold leading-tight"
            style={{
              color: 'var(--text)',
              letterSpacing: '-0.01em',
            }}
          >
            no relationships to map
          </h2>
          <p
            className="text-sm leading-relaxed"
            style={{ color: 'var(--text-muted)', maxWidth: 600 }}
          >
            Docglow builds the ERD from <code>relationships</code> tests and{' '}
            <code>meta.docglow.relationships</code> declarations. Add either to
            a <code>schema.yml</code> to populate this view.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <YamlCard
            label="relationships test"
            snippet={RELATIONSHIPS_TEST_YAML}
            testId="erd-empty-yaml-test"
          />
          <YamlCard
            label="meta.docglow"
            snippet={META_DOCGLOW_YAML}
            testId="erd-empty-yaml-meta"
          />
        </div>

        <div>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs hover:underline"
            style={{
              color: 'var(--color-primary, #2563eb)',
              fontFamily:
                'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
              letterSpacing: '0.04em',
            }}
            data-testid="erd-empty-docs-link"
          >
            Read the docs →
          </a>
        </div>
      </div>
    </div>
  )
}

// Exposed for tests.
export const ERD_EMPTY_DOCS_URL = DOCS_URL
export const ERD_EMPTY_RELATIONSHIPS_TEST_YAML = RELATIONSHIPS_TEST_YAML
export const ERD_EMPTY_META_DOCGLOW_YAML = META_DOCGLOW_YAML
