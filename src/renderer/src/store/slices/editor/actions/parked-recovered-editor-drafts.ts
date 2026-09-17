import type { AppState } from '../../../types'
import { type ClosedEditorTabSnapshot, MAX_RECENT_CLOSED_EDITOR_TABS } from '../types/open-file'
import { appendRecentlyClosedTabKind, pushRecentlyClosedTabKind } from '../../recently-closed-tabs'

export type ParkedRecoveredEditorDrafts = Pick<
  AppState,
  'recentlyClosedEditorTabsByWorktree' | 'recentlyClosedTabKindsByWorktree'
>

/**
 * Park recovered drafts at the front of one worktree's editor reopen stack. Both stacks move
 * together: the cross-type reopen pops the kind stack to decide whose snapshot to take.
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

/**
 * Queue one recovered draft at the BACK of both stacks. The front of each is the user's most recent
 * close, and a draft that cannot land yet must not block terminal/browser reopens behind it.
 */
export function deferRecoveredEditorDraft(
  state: ParkedRecoveredEditorDrafts,
  worktreeId: string,
  snapshot: ClosedEditorTabSnapshot
): ParkedRecoveredEditorDrafts {
  return {
    recentlyClosedEditorTabsByWorktree: {
      ...state.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: [
        ...(state.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []),
        snapshot
      ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
    },
    // Why the same end as the snapshot: LIFO pairing only holds while both enter the stacks together.
    recentlyClosedTabKindsByWorktree: appendRecentlyClosedTabKind(
      state.recentlyClosedTabKindsByWorktree,
      worktreeId,
      'editor'
    )
  }
}
