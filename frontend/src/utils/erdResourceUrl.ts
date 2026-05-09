/**
 * Map a dbt `unique_id` to the SPA route for its resource detail page.
 *
 * Convention mirrors `parseDepId` in `pages/ModelPage.tsx`: ids that begin
 * with `source.` route to `/source/<id>`; everything else (`model.`,
 * `seed.`, `snapshot.`, ...) routes to `/model/<id>`. The id is passed
 * through `encodeURIComponent` so atypical project names (spaces, slashes)
 * stay valid in the URL.
 *
 * Pure helper — extracted so the navigation logic in `ErdInspector` can be
 * unit-tested without spinning up a router.
 */
export function getResourceUrl(uniqueId: string): string {
  const type = uniqueId.startsWith('source.') ? 'source' : 'model'
  return `/${type}/${encodeURIComponent(uniqueId)}`
}
