/**
 * ErdPage — thin wrapper that hands `data.models` and `data.relationships`
 * (with the documented `?? []` guard from `@docglow/shared-types`) to
 * `ErdCanvas`. Page chrome (top bar / right rail) lives inside the canvas
 * itself, mirroring `LineagePage` which has no page-level heading either.
 */

import { ErdCanvas } from '../components/erd/ErdCanvas'
import { useProjectStore } from '../stores/projectStore'

export function ErdPage() {
  const { data } = useProjectStore()
  if (!data) return null
  const relationships = data.relationships ?? []
  return <ErdCanvas models={data.models} relationships={relationships} />
}
