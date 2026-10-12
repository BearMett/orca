// Renderer editor restore/save against the shared workspace-layout Loader/Serializer for two
// records of one path under different owners (local and a runtime environment).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { buildEditorSessionData } from '../../lib/workspace-session'
import { buildOwnedEditorFileId } from './editor/file-ids/editor-file-ids'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeWorktree } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const KEY = 'repo-1::/workspace'
const FILE_PATH = '/workspace/src/app.ts'
const REMOTE_ENV = 'env-remote'
const REMOTE_FILE_ID = buildOwnedEditorFileId(FILE_PATH, KEY, REMOTE_ENV)

const LOCAL_DIRTY: Partial<PersistedOpenFile> = {
  runtimeEnvironmentId: null,
  dirtyDraftContent: 'local draft',
  lastKnownDiskSignature: 'sig-local'
}
const REMOTE_DIRTY: Partial<PersistedOpenFile> = {
  runtimeEnvironmentId: REMOTE_ENV,
  dirtyDraftContent: 'remote draft',
  lastKnownDiskSignature: 'sig-remote'
}
const LOCAL_CLEAN: Partial<PersistedOpenFile> = { runtimeEnvironmentId: null }

function prepareStore() {
  const store = createTestStore()
  store.setState({
    repos: [
      { id: 'repo-1', path: '/workspace', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
    ],
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: KEY, repoId: 'repo-1', path: '/workspace' })]
    },
    activeWorktreeId: KEY
  })
  return store
}

function editorTab(id: string, overrides: Partial<Tab> & Pick<Tab, 'entityId'>): Tab {
  return {
    id,
    groupId: 'group-1',
    worktreeId: KEY,
    contentType: 'editor',
    label: 'app.ts',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

/** Two editor tabs (local file and runtime-owned file of one path), stored as the window saves them. */
function twinSession(
  owners: Partial<PersistedOpenFile>[],
  remotePreview = false
): WorkspaceSessionState {
  const tabs = [
    editorTab('tab-local', {
      entityId: FILE_PATH,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      sortOrder: 0
    }),
    editorTab('tab-remote', {
      entityId: REMOTE_FILE_ID,
      executionHostId: toRuntimeExecutionHostId(REMOTE_ENV),
      sortOrder: 1,
      ...(remotePreview ? { isPreview: true } : {})
    })
  ]
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: KEY,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: {
      [KEY]: owners.map((owner) => ({
        filePath: FILE_PATH,
        relativePath: 'src/app.ts',
        worktreeId: KEY,
        language: 'typescript',
        ...owner
      }))
    },
    unifiedTabs: { [KEY]: tabs },
    tabGroups: {
      [KEY]: [
        {
          id: 'group-1',
          worktreeId: KEY,
          activeTabId: 'tab-local',
          tabOrder: ['tab-local', 'tab-remote']
        }
      ]
    },
    tabGroupLayouts: { [KEY]: { type: 'leaf', groupId: 'group-1' } },
    activeGroupIdByWorktree: { [KEY]: 'group-1' }
  }
}

/** Owner ('local' or the runtime environment) → the draft its record carries. */
function draftsByOwner(files: readonly PersistedOpenFile[] | undefined) {
  return Object.fromEntries(
    (files ?? []).map((file) => [
      file.runtimeEnvironmentId ?? 'local',
      {
        dirtyDraftContent: file.dirtyDraftContent,
        lastKnownDiskSignature: file.lastKnownDiskSignature
      }
    ])
  )
}

function sharedSave(session: WorkspaceSessionState): WorkspaceSessionState {
  const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, nameBasedLoadContext())
  return JSON.parse(JSON.stringify(saveWorkspaceLayout(loaded)))
}

/** Restore through the real boot order, then save with the renderer's editor writer. */
function rendererRestoreThenSave(session: WorkspaceSessionState) {
  const store = prepareStore()
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)
  const state = store.getState()
  return buildEditorSessionData(state.openFiles, state.editorDrafts, {}, {}, {})
    .openFilesByWorktree?.[KEY]
}

const ORDERS: [string, Partial<PersistedOpenFile>[]][] = [
  ['local record stored first', [LOCAL_DIRTY, REMOTE_DIRTY]],
  ['runtime record stored first', [REMOTE_DIRTY, LOCAL_DIRTY]],
  ['only the runtime twin is dirty', [LOCAL_CLEAN, REMOTE_DIRTY]]
]

function hostOf(session: WorkspaceSessionState, tabId: string) {
  return session.unifiedTabs?.[KEY]?.find((tab) => tab.id === tabId)?.executionHostId
}

describe('case 3: editor drafts of same-path files with different owners', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(ORDERS)('%s: renderer restore keeps each owner its own draft', (_name, owners) => {
    const stored = twinSession(owners)

    expect(draftsByOwner(rendererRestoreThenSave(stored))).toEqual(
      draftsByOwner(stored.openFilesByWorktree?.[KEY])
    )
  })

  it.each(ORDERS)(
    '%s: shared round trip and renderer restore keep the same draft per owner',
    (_name, owners) => {
      const stored = twinSession(owners)

      expect(draftsByOwner(sharedSave(stored).openFilesByWorktree?.[KEY])).toEqual(
        draftsByOwner(rendererRestoreThenSave(stored))
      )
    }
  )

  it.each(ORDERS)(
    '%s: renderer restore of the shared save keeps each owner its own draft',
    (_name, owners) => {
      const stored = twinSession(owners)

      expect(draftsByOwner(rendererRestoreThenSave(sharedSave(stored)))).toEqual(
        draftsByOwner(stored.openFilesByWorktree?.[KEY])
      )
    }
  )
})

describe('extra: a runtime-owned editor tab names its file by owned id, not path', () => {
  it('shared round trip keeps the runtime-owned tab host stamp', () => {
    const stored = twinSession([LOCAL_CLEAN, REMOTE_DIRTY])

    expect(hostOf(sharedSave(stored), 'tab-remote')).toBe(hostOf(stored, 'tab-remote'))
  })

  it('shared round trip keeps the preview flag on a runtime-owned file', () => {
    const stored = twinSession(
      [LOCAL_CLEAN, { runtimeEnvironmentId: REMOTE_ENV, isPreview: true }],
      true
    )
    const remoteFile = (session: WorkspaceSessionState) =>
      session.openFilesByWorktree?.[KEY]?.find((file) => file.runtimeEnvironmentId === REMOTE_ENV)

    expect(remoteFile(sharedSave(stored))?.isPreview).toBe(remoteFile(stored)?.isPreview)
  })
})
