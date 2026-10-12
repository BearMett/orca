import { expect } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/store-test-helpers'

export const SAME_PATH_WORKTREE_ID = 'repo::/ws'
export const SAME_PATH_FROM = '/ws/a.ts'
export const SAME_PATH_TO = '/ws/b.ts'

export type SamePathOwner = 'local' | 'runtime' | 'ssh'

export const SAME_PATH_OWNER_IDS: Record<SamePathOwner, string> = {
  local: SAME_PATH_FROM,
  runtime: `editor:${encodeURIComponent(SAME_PATH_WORKTREE_ID)}:env-1:${encodeURIComponent(SAME_PATH_FROM)}`,
  ssh: 'editor-record:ssh-x:a'
}

/** Catalog host of the shared workspace; `runtime` stamps its rows `runtime:env-1`. */
export type SamePathWorkspaceRoute = 'local' | 'runtime'

/** What a local open stamps on its record; the only local evidence inside a runtime-routed workspace. */
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

/**
 * One workspace holding the same absolute path for three distinct hosts. In the local-routed
 * workspace the rows place the local record; in the runtime-routed one only its provenance does.
 */
export function seedSamePathEditorOwners(route: SamePathWorkspaceRoute = 'local'): void {
  const base = {
    filePath: SAME_PATH_FROM,
    relativePath: 'a.ts',
    worktreeId: SAME_PATH_WORKTREE_ID,
    language: 'typescript',
    isDirty: true,
    mode: 'edit'
  } as const
  const files: OpenFile[] = [
    {
      ...base,
      id: SAME_PATH_OWNER_IDS.local,
      runtimeEnvironmentId: null,
      ...(route === 'runtime' ? { operationProvenance: LOCAL_PROVENANCE } : {})
    },
    { ...base, id: SAME_PATH_OWNER_IDS.runtime, runtimeEnvironmentId: 'env-1' },
    {
      ...base,
      id: SAME_PATH_OWNER_IDS.ssh,
      runtimeEnvironmentId: null,
      externalSshTargetId: 'ssh-x'
    }
  ].map((file) => ({ ...file, lastKnownDiskSignature: `sig-${file.id}` }))
  const hostId = route === 'runtime' ? 'runtime:env-1' : undefined
  useAppStore.setState({
    repos: [
      {
        id: 'repo',
        path: '/ws',
        displayName: 'Repo',
        badgeColor: 'gray',
        addedAt: 0,
        ...(hostId ? { executionHostId: hostId } : {})
      }
    ],
    worktreesByRepo: {
      repo: [
        makeWorktree({
          id: SAME_PATH_WORKTREE_ID,
          repoId: 'repo',
          path: '/ws',
          ...(hostId ? { hostId } : {})
        })
      ]
    },
    openFiles: files,
    editorDrafts: Object.fromEntries(files.map((file) => [file.id, `draft ${file.id}`])),
    unifiedTabsByWorktree: {
      [SAME_PATH_WORKTREE_ID]: files.map((file, index) => ({
        id: file.id,
        entityId: file.id,
        groupId: 'group-1',
        worktreeId: SAME_PATH_WORKTREE_ID,
        contentType: 'editor',
        label: 'a.ts',
        customLabel: null,
        color: null,
        sortOrder: index,
        createdAt: 0
      }))
    }
  })
}

/** Moved owners now sit at the destination; every other owner is byte-for-byte untouched. */
export function expectOnlyOwnerMoved(moved: SamePathOwner): void {
  const state = useAppStore.getState()
  const tabs = state.unifiedTabsByWorktree[SAME_PATH_WORKTREE_ID] ?? []
  for (const owner of ['local', 'runtime', 'ssh'] as const) {
    const oldId = SAME_PATH_OWNER_IDS[owner]
    if (owner === moved) {
      const file = state.openFiles.find(
        (f) => f.filePath === SAME_PATH_TO && f.lastKnownDiskSignature === `sig-${oldId}`
      )
      expect(file?.filePath).toBe(SAME_PATH_TO)
      expect(state.editorDrafts[file!.id]).toBe(`draft ${oldId}`)
      expect(tabs.some((tab) => tab.entityId === file!.id)).toBe(true)
      continue
    }
    const file = state.openFiles.find((f) => f.id === oldId)
    expect(file?.filePath).toBe(SAME_PATH_FROM)
    expect(file?.lastKnownDiskSignature).toBe(`sig-${oldId}`)
    expect(file?.pendingSelfMoveEcho).toBeUndefined()
    expect(state.editorDrafts[oldId]).toBe(`draft ${oldId}`)
    expect(tabs.filter((tab) => tab.entityId === oldId).length).toBe(1)
  }
  expect(state.openFiles.length).toBe(3)
}
