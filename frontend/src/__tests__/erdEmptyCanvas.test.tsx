import { describe, it, expect } from 'vitest'
import {
  ERD_EMPTY_DOCS_URL,
  ERD_EMPTY_META_DOCGLOW_YAML,
  ERD_EMPTY_RELATIONSHIPS_TEST_YAML,
} from '../components/erd/ErdEmptyCanvas'

/* Logic-level checks — render coverage requires @testing-library/react,
   which is not a dep in this repo. We export the static content from the
   component module so we can verify its shape here. */

describe('ErdEmptyCanvas constants', () => {
  it('points the docs link at the configured ERD docs URL', () => {
    expect(ERD_EMPTY_DOCS_URL).toBe(
      'https://docs.docglow.com/configuration/erd',
    )
  })

  it('relationships-test snippet shows a dbt relationships test', () => {
    expect(ERD_EMPTY_RELATIONSHIPS_TEST_YAML).toContain('tests:')
    expect(ERD_EMPTY_RELATIONSHIPS_TEST_YAML).toContain('- relationships:')
    expect(ERD_EMPTY_RELATIONSHIPS_TEST_YAML).toContain("to: ref('customers')")
    expect(ERD_EMPTY_RELATIONSHIPS_TEST_YAML).toContain('field: customer_id')
    // meta block must NOT appear in the test snippet.
    expect(ERD_EMPTY_RELATIONSHIPS_TEST_YAML).not.toContain('meta:')
  })

  it('meta-docglow snippet shows a meta.docglow.relationships block', () => {
    expect(ERD_EMPTY_META_DOCGLOW_YAML).toContain('meta:')
    expect(ERD_EMPTY_META_DOCGLOW_YAML).toContain('docglow:')
    expect(ERD_EMPTY_META_DOCGLOW_YAML).toContain('relationships:')
    expect(ERD_EMPTY_META_DOCGLOW_YAML).toContain('- to: customers')
    // dbt-test syntax should NOT appear in the meta snippet.
    expect(ERD_EMPTY_META_DOCGLOW_YAML).not.toContain('tests:')
  })

  it('snippets are distinct', () => {
    expect(ERD_EMPTY_META_DOCGLOW_YAML).not.toEqual(
      ERD_EMPTY_RELATIONSHIPS_TEST_YAML,
    )
  })
})
