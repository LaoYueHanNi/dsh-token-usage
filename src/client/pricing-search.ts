import type { PricingOverviewModel } from '../wire.ts'

export function sortPricingModels(models: readonly PricingOverviewModel[]): PricingOverviewModel[] {
  return [...models].sort((a, b) => {
    const familyA = a.family ?? 'other', familyB = b.family ?? 'other'
    if (familyA !== familyB) return familyA < familyB ? -1 : 1
    return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0
  })
}

/** Substrings are a search aid only; server resolution determines identity. */
export function matchesPricingSearch(model: PricingOverviewModel, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return model.modelId.toLowerCase().includes(needle) || (model.family ?? 'other').toLowerCase().includes(needle)
    || model.aliases.some(alias => alias.toLowerCase().includes(needle))
}
