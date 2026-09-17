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
  const stack = [
    ...snapshots,
    ...(state.recentlyClosedEditorTabsByWorktree[worktreeId] ?? [])
  ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
  // Why counted rather than snapshots.length: the cap drops the overflow, and a kind entry with no
  // snapshot behind it makes a later cross-type reopen pop an editor that is not there.
  const parkedCount = Math.min(snapshots.length, stack.length)
  return {
    recentlyClosedEditorTabsByWorktree: {
      ...state.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: stack
    },
    recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
      state.recentlyClosedTabKindsByWorktree,
      worktreeId,
      'editor',
      parkedCount
    )
  }
}

/** Recovered drafts beyond `MAX_RECENT_CLOSED_EDITOR_TABS` are lost, so the heal can report them. */
export function countRecoveredDraftsLostToCap(snapshotCount: number): number {
  return Math.max(0, snapshotCount - MAX_RECENT_CLOSED_EDITOR_TABS)
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
  const stack = state.recentlyClosedEditorTabsByWorktree[worktreeId] ?? []
  // Why nothing moves: a tail defer is the first entry the cap drops, and pushing its kind anyway
  // would leave a cross-type reopen popping an editor snapshot that is not in the stack.
  if (stack.length >= MAX_RECENT_CLOSED_EDITOR_TABS) {
    return {
      recentlyClosedEditorTabsByWorktree: state.recentlyClosedEditorTabsByWorktree,
      recentlyClosedTabKindsByWorktree: state.recentlyClosedTabKindsByWorktree
    }
  }
  return {
    recentlyClosedEditorTabsByWorktree: {
      ...state.recentlyClosedEditorTabsByWorktree,
      [worktreeId]: [...stack, snapshot]
    },
    // Why the same end as the snapshot: LIFO pairing only holds while both enter the stacks together.
    recentlyClosedTabKindsByWorktree: appendRecentlyClosedTabKind(
      state.recentlyClosedTabKindsByWorktree,
      worktreeId,
      'editor'
    )
  }
}
