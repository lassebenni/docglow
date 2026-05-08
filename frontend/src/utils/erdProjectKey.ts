/**
 * Project-key derivation for ERD localStorage scoping (DOC-99 U2).
 *
 * The ERD store persists drag-rearranged node positions to localStorage,
 * keyed per project so that switching to a different docglow site doesn't
 * carry over stale layouts. We derive a project key from
 * `DocglowData.metadata.project_name` — the simplest stable identifier
 * available in the payload.
 *
 * Per the v1.1 plan ("Open Questions on project-key derivation"), name
 * collisions across distinct projects are accepted as a v1.1 limitation —
 * we do NOT hash, concatenate paths, or otherwise harden against collisions.
 */
import type { DocglowData } from '../types';

/** Fallback key used when no `project_name` is available. */
export const DEFAULT_PROJECT_KEY = '_default_';

/**
 * Derive the localStorage scoping key for a given project payload.
 *
 * Returns `DEFAULT_PROJECT_KEY` when the payload is null/undefined or when
 * `metadata.project_name` is missing or empty.
 */
export function getProjectKey(data: DocglowData | null | undefined): string {
  const name = data?.metadata?.project_name;
  if (typeof name !== 'string' || name.length === 0) {
    return DEFAULT_PROJECT_KEY;
  }
  return name;
}
