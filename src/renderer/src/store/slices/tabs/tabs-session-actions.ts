import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { addAdditionalValidWorkspaceKeys } from '@/lib/workspace-session-hydration-keys'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from '../degraded-repo-worktree-validity'
import { buildHydratedTabState } from '../tabs-hydration'
import { projectWorktreeTabModelReconciliation } from './tabs-reconciliation'
import { createWorktreeTabModelReconciliationBatch } from './tabs-reconciliation-batch'
import type { AppState } from '../../types'

function replaceWorkspaceRecordKeys<T>(
  current: Record<string, T>,
  hydrated: Record<string, T>,
  workspaceKeys: ReadonlySet<string>
): Record<string, T> {
  return {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !workspaceKeys.has(key))),
    ...Object.fromEntries(Object.entries(hydrated).filter(([key]) => workspaceKeys.has(key)))
  }
}

/**
 * Folds every workspace's reconciliation into one patch. Equivalent to
 * applying each patch with its own `set()`: each projection reads the state
 * left by its predecessors (they share `unreadTerminalTabs` and the orphan
 * cleanup maps), only the store write and subscriber fanout are deferred.
 */
function projectWorktreeTabModelReconciliations(
  state: AppState,
  worktreeIds: readonly string[]
): Partial<AppState> {
  const batch = createWorktreeTabModelReconciliationBatch(state)
  // Private working copy so batch-owned maps can be written in place.
  const working = { ...state }
  const merged: Partial<AppState> = {}
  const orphanEditorFileIds = new Set<string>()
  for (const worktreeId of worktreeIds) {
    const reconciliation = projectWorktreeTabModelReconciliation(working, worktreeId, batch)
    for (const fileId of reconciliation.orphanEditorFileIds) {
      orphanEditorFileIds.add(fileId)
    }
    if (Object.keys(reconciliation.patch).length === 0) {
      continue
    }
    Object.assign(merged, reconciliation.patch)
    Object.assign(working, reconciliation.patch)
  }
  // Why only here: `openFiles` is written once the whole fold is projected, so the batch's
  // one-shot editor index stays valid — and an unsaved buffer is never swept.
  if (orphanEditorFileIds.size > 0) {
    const sweptFileIds = new Set(
      state.openFiles
        .filter((file) => file.isDirty !== true && orphanEditorFileIds.has(file.id))
        .map((file) => file.id)
    )
    if (sweptFileIds.size > 0) {
      merged.openFiles = state.openFiles.filter((file) => !sweptFileIds.has(file.id))
      const tabBarOrder = pruneTabBarOrderEntries(
        working.tabBarOrderByWorktree ?? state.tabBarOrderByWorktree,
        sweptFileIds
      )
      if (tabBarOrder) {
        merged.tabBarOrderByWorktree = tabBarOrder
      }
    }
  }
  return merged
}

/** Why: a swept id left in the strip order still shifts positions on the next reconcile. */
function pruneTabBarOrderEntries(
  tabBarOrderByWorktree: AppState['tabBarOrderByWorktree'],
  sweptFileIds: ReadonlySet<string>
): AppState['tabBarOrderByWorktree'] | null {
  if (!tabBarOrderByWorktree) {
    return null
  }
  let changed = false
  const next: AppState['tabBarOrderByWorktree'] = {}
  for (const [worktreeId, order] of Object.entries(tabBarOrderByWorktree)) {
    const pruned = order.filter((entryId) => !sweptFileIds.has(entryId))
    changed = changed || pruned.length !== order.length
    next[worktreeId] = pruned.length === order.length ? order : pruned
  }
  return changed ? next : null
}

export function createTabsSessionActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  'reconcileWorktreeTabModel' | 'reconcileWorktreeTabModels' | 'hydrateTabsSession'
> {
  return {
    reconcileWorktreeTabModels: (worktreeIds) => {
      if (worktreeIds.length === 0) {
        return
      }
      const patch = projectWorktreeTabModelReconciliations(get(), worktreeIds)
      if (Object.keys(patch).length > 0) {
        set(patch)
      }
    },

    reconcileWorktreeTabModel: (worktreeId) => {
      const reconciliation = projectWorktreeTabModelReconciliation(get(), worktreeId)
      if (Object.keys(reconciliation.patch).length > 0) {
        set(reconciliation.patch)
      }
      return {
        renderableTabCount: reconciliation.renderableTabCount,
        activeRenderableTabId: reconciliation.activeRenderableTabId
      }
    },

    hydrateTabsSession: (session, options) => {
      const state = get()
      const persistedWorktreeIds = collectPersistedWorktreeIdsForSessionHydration(session)
      const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(state, persistedWorktreeIds)
      validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of state.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
      const hydrated = buildHydratedTabState(session, validWorktreeIds)
      if (!options?.replaceWorkspaceKeys) {
        set(hydrated)
        return
      }
      const replaceWorkspaceKeys = new Set(options.replaceWorkspaceKeys)
      set((current) => ({
        unifiedTabsByWorktree: replaceWorkspaceRecordKeys(
          current.unifiedTabsByWorktree,
          hydrated.unifiedTabsByWorktree,
          replaceWorkspaceKeys
        ),
        groupsByWorktree: replaceWorkspaceRecordKeys(
          current.groupsByWorktree,
          hydrated.groupsByWorktree,
          replaceWorkspaceKeys
        ),
        activeGroupIdByWorktree: replaceWorkspaceRecordKeys(
          current.activeGroupIdByWorktree,
          hydrated.activeGroupIdByWorktree,
          replaceWorkspaceKeys
        ),
        layoutByWorktree: replaceWorkspaceRecordKeys(
          current.layoutByWorktree,
          hydrated.layoutByWorktree,
          replaceWorkspaceKeys
        )
      }))
    }
  }
}
