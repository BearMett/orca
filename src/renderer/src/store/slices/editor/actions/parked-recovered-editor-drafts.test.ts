import { describe, expect, it } from 'vitest'
import type { ClosedEditorTabSnapshot } from '../types/open-file'
import {
  parkRecoveredEditorDrafts,
  type ParkedRecoveredEditorDrafts
} from './parked-recovered-editor-drafts'

const WORKTREE_ID = 'repo-1::/workspace'

function snapshot(index: number): ClosedEditorTabSnapshot {
  return {
    filePath: `/workspace/draft-${index}.ts`,
    relativePath: `draft-${index}.ts`,
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    mode: 'edit',
    dirtyDraftContent: `draft ${index}`
  }
}

const EMPTY: ParkedRecoveredEditorDrafts = {
  recentlyClosedEditorTabsByWorktree: {},
  recentlyClosedTabKindsByWorktree: {}
}

describe('parkRecoveredEditorDrafts', () => {
  it('pairs every parked snapshot with one cross-type reopen entry', () => {
    for (const count of [1, 3, 10]) {
      const snapshots = Array.from({ length: count }, (_value, index) => snapshot(index))

      const parked = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, snapshots)

      expect(parked.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]).toHaveLength(count)
      expect(parked.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(
        Array.from({ length: count }, () => 'editor')
      )
    }
  })

  it('never pushes more kind entries than snapshots when the editor stack overflows', () => {
    const snapshots = Array.from({ length: 24 }, (_value, index) => snapshot(index))

    const parked = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, snapshots)

    const stack = parked.recentlyClosedEditorTabsByWorktree[WORKTREE_ID]
    const kinds = parked.recentlyClosedTabKindsByWorktree[WORKTREE_ID]
    expect(stack.length).toBeLessThan(snapshots.length)
    expect(kinds).toHaveLength(snapshots.length)
    expect(kinds.every((kind) => kind === 'editor')).toBe(true)
  })

  it('stacks newest first on top of what the worktree already parked', () => {
    const existing = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, [snapshot(1)])

    const parked = parkRecoveredEditorDrafts(existing, WORKTREE_ID, [snapshot(2)])

    expect(
      parked.recentlyClosedEditorTabsByWorktree[WORKTREE_ID].map((entry) => entry.filePath)
    ).toEqual(['/workspace/draft-2.ts', '/workspace/draft-1.ts'])
    expect(parked.recentlyClosedTabKindsByWorktree[WORKTREE_ID]).toEqual(['editor', 'editor'])
  })

  it('leaves both stacks untouched when there is nothing to park', () => {
    const existing = parkRecoveredEditorDrafts(EMPTY, WORKTREE_ID, [snapshot(1)])

    const parked = parkRecoveredEditorDrafts(existing, WORKTREE_ID, [])

    expect(parked.recentlyClosedEditorTabsByWorktree).toBe(
      existing.recentlyClosedEditorTabsByWorktree
    )
    expect(parked.recentlyClosedTabKindsByWorktree).toBe(existing.recentlyClosedTabKindsByWorktree)
  })
})
