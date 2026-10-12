import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  partitionOpenFilesForPathMove,
  selectOpenFilesForPathMove
} from './open-editor-path-move-selection'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

const WORKTREE_ID = 'repo::/ws'
const LOCAL_MOVE = { runtimeEnvironmentId: null, sshTargetId: null }
const ENV_1_MOVE = { runtimeEnvironmentId: 'env-1', sshTargetId: null }
const SSH_X_MOVE = { runtimeEnvironmentId: null, sshTargetId: 'ssh-x' }

const LOCAL_PROVENANCE: NonNullable<OpenFile['operationProvenance']> = {
  ownershipProjection: 'explicit',
  generation: {
    route: { executionHostId: 'local', runtimeEnvironmentId: null },
    runtimeConnectionGeneration: null,
    runtimePairingRevision: undefined,
    runtimeSshGeneration: null,
    nestedSshGeneration: null,
    directSshGeneration: null
  }
}

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

type Move = typeof LOCAL_MOVE | typeof ENV_1_MOVE | typeof SSH_X_MOVE

function selectedIds(
  state: WorktreeOperationRouteState & { openFiles: OpenFile[] },
  owner: Move
): string[] {
  return selectOpenFilesForPathMove(state, '/ws/a.ts', owner).map((file) => file.id)
}

function workspaceRows(
  hostId: 'local' | 'runtime:env-1' | 'ssh:ssh-x'
): WorktreeOperationRouteState {
  return {
    repos: [{ id: 'repo', connectionId: null, executionHostId: hostId }],
    worktreesByRepo: { repo: [{ id: WORKTREE_ID, repoId: 'repo', hostId }] }
  }
}

describe('selectOpenFilesForPathMove', () => {
  it('reads an ownerless record in a runtime-routed workspace as that runtime', () => {
    const state = { ...workspaceRows('runtime:env-1'), openFiles: [editorFile('ownerless')] }

    expect(selectedIds(state, ENV_1_MOVE)).toEqual(['ownerless'])
    expect(selectedIds(state, LOCAL_MOVE)).toEqual([])
  })

  it('reads an ownerless record in a local-routed workspace as this machine', () => {
    const state = { ...workspaceRows('local'), openFiles: [editorFile('ownerless')] }

    expect(selectedIds(state, LOCAL_MOVE)).toEqual(['ownerless'])
    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
    expect(selectedIds(state, SSH_X_MOVE)).toEqual([])
  })

  it('reads a runtime-less record in an SSH workspace as that SSH host, never as local', () => {
    // Files inside an SSH worktree carry no SSH marker of their own: only the workspace rows do.
    const state = {
      ...workspaceRows('ssh:ssh-x'),
      openFiles: [editorFile('ssh-file', { runtimeEnvironmentId: null })]
    }

    expect(selectedIds(state, SSH_X_MOVE)).toEqual(['ssh-file'])
    expect(selectedIds(state, LOCAL_MOVE)).toEqual([])
    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
  })

  it('moves a local-provenance record only on a local rename, even in a runtime-routed workspace', () => {
    const state = {
      ...workspaceRows('runtime:env-1'),
      openFiles: [
        editorFile('local', { runtimeEnvironmentId: null, operationProvenance: LOCAL_PROVENANCE })
      ]
    }

    expect(selectedIds(state, LOCAL_MOVE)).toEqual(['local'])
    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
  })

  it('leaves a runtime-less record without provenance in a runtime-routed workspace where it is', () => {
    const state = {
      ...workspaceRows('runtime:env-1'),
      openFiles: [editorFile('unplaced', { runtimeEnvironmentId: null })]
    }

    expect(selectedIds(state, LOCAL_MOVE)).toEqual([])
    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
    expect(
      partitionOpenFilesForPathMove(state, '/ws/a.ts', LOCAL_MOVE).unresolved.map((f) => f.id)
    ).toEqual(['unplaced'])
  })

  it('reports a placed record on another host as excluded, not unresolved', () => {
    const state = { ...workspaceRows('ssh:ssh-x'), openFiles: [editorFile('ssh-file')] }
    const result = partitionOpenFilesForPathMove(state, '/ws/a.ts', LOCAL_MOVE)
    expect(result.selected).toEqual([])
    expect(result.unresolved).toEqual([])
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

  const NO_ROWS: WorktreeOperationRouteState = {}
  const RIVAL_LOCAL_AND_SSH_ROWS: WorktreeOperationRouteState = {
    repos: [
      { id: 'repo', connectionId: null, executionHostId: 'local' },
      { id: 'repo-ssh', connectionId: 'ssh-x', executionHostId: 'ssh:ssh-x' }
    ],
    worktreesByRepo: {
      repo: [{ id: WORKTREE_ID, repoId: 'repo', hostId: 'local' }],
      'repo-ssh': [{ id: WORKTREE_ID, repoId: 'repo-ssh', hostId: 'ssh:ssh-x' }]
    }
  }

  it.each([
    ['no catalog row', NO_ROWS],
    ['rival local and SSH rows', RIVAL_LOCAL_AND_SSH_ROWS]
  ])('leaves a runtime-less record where it is when its workspace has %s', (_label, rows) => {
    const state = {
      ...rows,
      openFiles: [
        editorFile('ownerless'),
        editorFile('runtime-less', { runtimeEnvironmentId: null }),
        editorFile('floating', {
          runtimeEnvironmentId: null,
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID
        })
      ]
    }
    expect(resolveWorktreeOperationRoute(state, WORKTREE_ID)).toBeNull()

    // Why: a null runtime is not local evidence; an SSH workspace's files look the same after restore.
    expect(selectedIds(state, LOCAL_MOVE)).toEqual(['floating'])
    expect(selectedIds(state, ENV_1_MOVE)).toEqual([])
    expect(selectedIds(state, SSH_X_MOVE)).toEqual([])
    // The caller must refuse: either record may be the renaming host's own copy.
    for (const move of [LOCAL_MOVE, ENV_1_MOVE, SSH_X_MOVE]) {
      expect(
        partitionOpenFilesForPathMove(state, '/ws/a.ts', move).unresolved.map((f) => f.id)
      ).toEqual(['ownerless', 'runtime-less'])
    }
  })
})
