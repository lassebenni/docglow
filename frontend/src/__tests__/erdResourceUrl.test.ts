import { describe, it, expect } from 'vitest'
import { getResourceUrl } from '../utils/erdResourceUrl'

describe('getResourceUrl', () => {
  it('routes a model unique_id to /model/<encoded id>', () => {
    expect(getResourceUrl('model.jaffle_shop.orders')).toBe(
      '/model/model.jaffle_shop.orders',
    )
  })

  it('routes a source unique_id to /source/<encoded id>', () => {
    expect(getResourceUrl('source.jaffle_shop.raw_orders')).toBe(
      '/source/source.jaffle_shop.raw_orders',
    )
  })

  it('routes seed/snapshot ids to /model/... (only `source.` is special-cased)', () => {
    expect(getResourceUrl('seed.proj.country_codes')).toBe(
      '/model/seed.proj.country_codes',
    )
    expect(getResourceUrl('snapshot.proj.orders_snapshot')).toBe(
      '/model/snapshot.proj.orders_snapshot',
    )
  })

  it('encodes characters that need URL-escaping', () => {
    // Hypothetical project name with a space — encodeURIComponent turns
    // ` ` into `%20` and leaves dots untouched.
    expect(getResourceUrl('model.my project.orders')).toBe(
      '/model/model.my%20project.orders',
    )
    // A `/` in the id should also encode.
    expect(getResourceUrl('model.proj/sub.x')).toBe(
      '/model/model.proj%2Fsub.x',
    )
  })

  it('does not match a substring `source.` mid-id (must be the prefix)', () => {
    // Defensive: a model named `model.x.source.foo` is still a model.
    expect(getResourceUrl('model.x.source.foo')).toBe(
      '/model/model.x.source.foo',
    )
  })
})
