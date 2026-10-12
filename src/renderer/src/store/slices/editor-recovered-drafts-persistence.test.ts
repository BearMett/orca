import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { workspaceSessionStateSchema } from '../../../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { remapOpenEditorTabsForPathChange } from '@/lib/remap-open-editor-tabs-for-path-change'
import { useAppStore } from '@/store'
import { isAutosaveSuspendedForFile } from '../../components/editor/editor-autosave'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeWorktree } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createStoreSessionMockApi()
const WT = 'repo::/workspace'
const PATH = '/workspace/note.txt'

function hydrate(session: WorkspaceSessionState) {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo', path: '/workspace', displayName: 'Repo', badgeColor: 'gray', addedAt: 0 }
    ],
    worktreesByRepo: { repo: [makeWorktree({ id: WT, repoId: 'repo', path: '/workspace' })] },
    activeWorktreeId: WT
  })
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)
  return store
}

function saved(store: ReturnType<typeof hydrate>) {
  return workspaceSessionStateSchema.parse(
    JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(store.getState())))
  )
}

function signatures(store: ReturnType<typeof hydrate>) {
  const state = store.getState()
  return Object.fromEntries(
    state.openFiles.map((file) => [
      file.id,
      [state.editorDrafts[file.id], file.lastKnownDiskSignature]
    ])
  )
}

describe('recovered editor drafts survive hot exit', () => {
  it('keeps fourteen divergent drafts reachable, stable, and suspended through three restarts', () => {
    let store = hydrate({
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [WT]: Array.from({ length: 14 }, (_, index) => ({
          filePath: PATH,
          relativePath: 'note.txt',
          worktreeId: WT,
          language: 'plaintext',
          dirtyDraftContent: `draft-${index}`,
          lastKnownDiskSignature: `baseline-${index}`
        }))
      }
    })
    const expected = signatures(store)
    expect(Object.keys(expected)).toHaveLength(14)
    for (let restart = 0; restart < 3; restart++) {
      const state = store.getState()
      for (const file of state.openFiles) {
        expect(state.unifiedTabsByWorktree[WT]?.some((tab) => tab.entityId === file.id)).toBe(true)
        expect(isAutosaveSuspendedForFile(file)).toBe(true)
      }
      const serialized = saved(store)
      const shared = loadWorkspaceLayout('local', serialized, nameBasedLoadContext())
      store = hydrate(saveWorkspaceLayout(shared))
      expect(signatures(store)).toEqual(expected)
    }
  })

  it('closing and reordering one recovery cannot move another draft onto its id', () => {
    const initial = hydrate({
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [WT]: ['first', 'second', 'third'].map((draft) => ({
          filePath: PATH,
          relativePath: 'note.txt',
          worktreeId: WT,
          language: 'plaintext',
          dirtyDraftContent: draft
        }))
      }
    })
    const [first, second, third] = initial.getState().openFiles
    if (!first || !second || !third) {
      throw new Error('fixture lost a draft')
    }
    initial.getState().closeFile(second.id)
    initial.getState().reorderFiles([third.id, first.id])
    expect(signatures(hydrate(saved(initial)))).toEqual(signatures(initial))
    expect(Object.keys(signatures(initial))).toHaveLength(2)
  })

  it('renames fourteen recovered buffers without merging their drafts or IDs', () => {
    const store = hydrate({
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [WT]: Array.from({ length: 14 }, (_, index) => ({
          filePath: PATH,
          relativePath: 'note.txt',
          worktreeId: WT,
          language: 'plaintext',
          dirtyDraftContent: `draft-${index}`,
          lastKnownDiskSignature: `baseline-${index}`
        }))
      }
    })
    const expected = signatures(store)
    const previous = useAppStore.getState()
    useAppStore.setState(store.getState(), true)
    try {
      expect(
        remapOpenEditorTabsForPathChange({
          fromPath: PATH,
          toPath: '/workspace/renamed.txt',
          worktreePath: '/workspace',
          worktreeId: WT,
          operationOwner: { runtimeEnvironmentId: null, sshTargetId: null }
        }).ok
      ).toBe(true)
      expect(
        store.getState().openFiles.every((file) => file.filePath === '/workspace/renamed.txt')
      ).toBe(true)
      expect(signatures(hydrate(saved(store)))).toEqual(expected)
    } finally {
      useAppStore.setState(previous, true)
    }
  })

  it('preserves drafts from two external SSH owners sharing an absolute path', () => {
    const store = hydrate({
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [WT]: ['ssh-one', 'ssh-two'].map((externalSshTargetId) => ({
          filePath: PATH,
          relativePath: 'note.txt',
          worktreeId: WT,
          language: 'plaintext',
          externalSshTargetId,
          dirtyDraftContent: externalSshTargetId
        }))
      }
    })
    expect(Object.values(store.getState().editorDrafts).sort()).toEqual(['ssh-one', 'ssh-two'])
    expect(signatures(hydrate(saved(store)))).toEqual(signatures(store))
  })

  it('restores writable, read-only and live-tail views of one path as three files', () => {
    const view = (flags: { readOnly?: true; liveTail?: true }) => ({
      filePath: PATH,
      relativePath: 'note.txt',
      worktreeId: WT,
      language: 'plaintext',
      ...flags
    })
    const views = (store: ReturnType<typeof hydrate>) =>
      store
        .getState()
        .openFiles.map((file) => [file.filePath, file.readOnly, file.liveTail])
        .sort()
    let store = hydrate({
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: {
        [WT]: [view({ readOnly: true }), view({ readOnly: true, liveTail: true }), view({})]
      }
    })
    const expected = [
      [PATH, undefined, undefined],
      [PATH, true, undefined],
      [PATH, true, true]
    ]
    expect(views(store)).toEqual(expected)
    store = hydrate(
      saveWorkspaceLayout(loadWorkspaceLayout('local', saved(store), nameBasedLoadContext()))
    )
    expect(views(store)).toEqual(expected)
  })
})
