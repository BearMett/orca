import type { TabGroup } from '../tab-types'

/** Prevent one retained tab row from hydrating into multiple groups. */
export function resolveTabGroupOwners(
  tabs: readonly { id: string; groupId?: string }[],
  groups: readonly TabGroup[],
  tabIdAliasesByGroup?: Map<string, Map<string, string>>
): Map<string, string> {
  const persistedGroupIds = new Set(groups.map((group) => group.id))
  const tabGroupIdById = new Map(tabs.map((tab) => [tab.id, tab.groupId]))
  const tabOwners = new Map(
    tabs.flatMap((tab) =>
      tab.groupId && persistedGroupIds.has(tab.groupId) ? [[tab.id, tab.groupId] as const] : []
    )
  )
  for (const group of groups) {
    const tabIdAliases = tabIdAliasesByGroup?.get(group.id)
    for (const persistedTabId of group.tabOrder) {
      const tabId = tabIdAliases?.get(persistedTabId) ?? persistedTabId
      if (!tabGroupIdById.has(tabId)) {
        continue
      }
      if (!tabOwners.has(tabId)) {
        tabOwners.set(tabId, group.id)
      }
    }
  }
  return tabOwners
}
