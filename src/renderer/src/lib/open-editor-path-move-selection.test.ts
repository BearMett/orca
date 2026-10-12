import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { selectOpenFilesForPathMove } from './open-editor-path-move-selection'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

const WORKTREE_ID = 'repo::/ws'
const LOCAL_MOVE = { runtimeEnvironmentId: null, sshTargetId: null }
const ENV_1_MOVE = { runtimeEnvironmentId: 'env-1', sshTargetId: null }

function editorFile(id: string, owner: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/ws/a.ts',
    relativePath: 'a.ts',
    worktreeId: WORKTREE_ID,
    language: 'typescript',
    isDirty: true,
    mode: 'edit',
    ...owner
  }
}

function selectedIds(
  state: WorktreeOperationRouteState & { openFiles: OpenFile[] },
  owner: typeof LOCAL_MOVE | typeof ENV_1_MOVE
): string[] {
  return selectOpenFilesForPathMove(state, '/ws/a.ts', WORKTREE_ID, owner).map((file) => file.id)
}

describe('selectOpenFilesForPathMove', () => {
  const runtimeRouted: WorktreeOperationRouteState = {
    repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:env-1' }],
    worktreesByRepo: { repo: [{ id: WORKTREE_ID, repoId: 'repo', hostId: 'runtime:env-1' }] }
  }

  it('reads an ownerless record in a runtime-routed workspace as that runtime', () => {
    const state = { ...runtimeRouted, openFiles: [editorFile('ownerless')] }

    expect(selectedIds(state, ENV_1_MOVE)).toEqual(['ownerless'])
    expect(selectedIds(state, LOCAL_MOVE)).toEqual([])
  })

  it('moves an explicitly runtime-less record only with a local rename', () => {
    const state = {
      ...runtimeRouted,
      openFiles: [editorFile('local', { runtimeEnvironmentId: null })]
    }

    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
    expect(selectedIds(state, LOCAL_MOVE)).toEqual(['local'])
  })

  it('places an ownerless record by its workspace rows, not the Active Server setting', () => {
    // Detected-only row: the legacy branch is the only one that reads the setting.
    const rows: WorktreeOperationRouteState = {
      runtimeEnvironments: [{ id: 'env-1' }],
      runtimeEnvironmentCatalogHydrated: true,
      detectedWorktreesByRepo: { repo: { worktrees: [{ id: WORKTREE_ID, repoId: 'repo' }] } }
    }
    const focused = { ...rows, settings: { activeRuntimeEnvironmentId: 'env-1' } }
    // Precondition: with the setting the route reads env-1; without it, this machine.
    expect(resolveWorktreeOperationRoute(focused, WORKTREE_ID)?.executionHostId).toBe(
      'runtime:env-1'
    )
    expect(resolveWorktreeOperationRoute(rows, WORKTREE_ID)?.executionHostId).toBe('local')
    const state = { ...focused, openFiles: [editorFile('ownerless')] }

    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
    expect(selectedIds(state, LOCAL_MOVE)).toEqual(['ownerless'])
  })

  it('moves an unrouted record only when it says no runtime, in the moving workspace, on a local rename', () => {
    const state: WorktreeOperationRouteState & { openFiles: OpenFile[] } = {
      openFiles: [
        editorFile('ownerless'),
        editorFile('runtime-less', { runtimeEnvironmentId: null }),
        editorFile('other-workspace', { runtimeEnvironmentId: null, worktreeId: 'repo::/other' })
      ]
    }
    expect(resolveWorktreeOperationRoute(state, WORKTREE_ID)).toBeNull()

    expect(selectedIds(state, LOCAL_MOVE)).toEqual(['runtime-less'])
    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
  })
})
