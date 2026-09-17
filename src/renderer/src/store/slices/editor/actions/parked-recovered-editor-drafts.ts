import type { AppState } from '../../../types'
import { type ClosedEditorTabSnapshot, MAX_RECENT_CLOSED_EDITOR_TABS } from '../types/open-file'
import { pushRecentlyClosedTabKind } from '../../recently-closed-tabs'

export type ParkedRecoveredEditorDrafts = Pick<
  AppState,
  'recentlyClosedEditorTabsByWorktree' | 'recentlyClosedTabKindsByWorktree'
>

/**
 * Park recovered drafts on one worktree's editor reopen stack. Both stacks move together because
 * the cross-type reopen pops the kind stack to decide whose snapshot to take: a snapshot pushed
 * without its `'editor'` entry is a draft no reopen can reach, and it sends the next editor close's
 * own snapshot to the back of the queue.
 */
export function parkRecoveredEditorDrafts(
  state: ParkedRecoveredEditorDrafts,
  worktreeId: string,
  snapshots: readonly ClosedEditorTabSnapshot[]
): ParkedRecoveredEditorDrafts {
  if (snapshots.length === 0) {
    return {
      recentlyClosedEditorTabsByWorktree: state.recentlyClosedEditorTabsByWorktree,
      recentlyClosedTabKindsByWorktree: state.recentlyClosedTabKindsByWorktree
    }
  }
  return {
    recentlyClosedEditorTabsByWorktree: {
      ...state.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: [
        ...snapshots,
        ...(state.recentlyClosedEditorTabsByWorktree[worktreeId] ?? [])
      ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
    },
    recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
      state.recentlyClosedTabKindsByWorktree,
      worktreeId,
      'editor',
      snapshots.length
    )
  }
}
