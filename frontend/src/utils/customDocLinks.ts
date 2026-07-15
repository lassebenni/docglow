import type { CustomDoc } from '../types'

export interface ResolvedCustomDocLink {
  slug: string
  anchor: string
}

/**
 * Resolve in-doc links authored as "<slug>#<anchor>" (e.g. workbook#cte-foo),
 * sibling "*.html" files, or same-page "#anchor" fragments against the model's
 * custom_docs slugs. Returns null when the href should use normal navigation.
 */
export function resolveCustomDocLink(
  href: string,
  currentSlug: string,
  customDocs: readonly CustomDoc[],
): ResolvedCustomDocLink | null {
  const trimmed = href.trim()
  if (!trimmed || /^(https?:|mailto:|tel:|javascript:)/i.test(trimmed)) {
    return null
  }

  const slugs = new Set(customDocs.map(doc => doc.slug))

  if (trimmed.startsWith('#')) {
    return { slug: currentSlug, anchor: trimmed.slice(1) }
  }

  const hashIdx = trimmed.indexOf('#')
  const pathPart = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
  const anchor = hashIdx === -1 ? '' : trimmed.slice(hashIdx + 1)

  // slug-only references: guide, workbook, self, guide#anchor, workbook#anchor
  if (!pathPart.includes('/') && !pathPart.includes('.')) {
    const slug = pathPart === 'self' || pathPart === '' ? 'guide' : pathPart
    if (slugs.has(slug)) {
      return { slug, anchor }
    }
    return null
  }

  // sibling html: guide.html, ./workbook.html
  const htmlMatch = pathPart.match(/(?:^|\/)([^/]+)\.html$/)
  if (htmlMatch) {
    const slug = htmlMatch[1]!
    if (slugs.has(slug)) {
      return { slug, anchor }
    }
  }

  // site-relative copy path: docs/<model>/<slug>.html
  const siteMatch = pathPart.match(/\/([^/]+)\.html$/)
  if (siteMatch) {
    const slug = siteMatch[1]!
    if (slugs.has(slug)) {
      return { slug, anchor }
    }
  }

  return null
}

/** Scroll an iframe document to an element id or named anchor. */
export function scrollIframeToAnchor(doc: Document, anchor: string): boolean {
  if (!anchor) return false
  const target =
    doc.getElementById(anchor) ??
    doc.querySelector(`a[name="${CSS.escape(anchor)}"]`) ??
    doc.querySelector(`[id="${CSS.escape(anchor)}"]`)
  if (!target) return false
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return true
}
