// Renderer editor restore/save against the shared workspace-layout Loader/Serializer for two
// records of one path under different owners (local and a runtime environment).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Tab } from '../../../../shared/tab-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { loadWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../../shared/workspace-layout/workspace-layout-minted-ids'
import { saveWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-save'
import { buildEditorSessionData, buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { reconcileHydratedWorkspaceTabModels } from '../../app-shell/reconcile-hydrated-workspace-tab-models'
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

const OTHER_PATH = '/workspace/src/other.ts'

/** A pinned, selected tab naming a legacy owned draft by its raw path, as pre-owned-id windows saved it. */
function legacyOwnedDraftSession(
  owner: Partial<PersistedOpenFile>,
  executionHostId: ExecutionHostId
): WorkspaceSessionState {
  return {
    ...twinSession([]),
    openFilesByWorktree: {
      [KEY]: [
        // Listed first so a dropped selection cannot fall back onto the draft by accident.
        {
          filePath: OTHER_PATH,
          relativePath: 'src/other.ts',
          worktreeId: KEY,
          language: 'typescript'
        },
        {
          filePath: FILE_PATH,
          relativePath: 'src/app.ts',
          worktreeId: KEY,
          language: 'typescript',
          ...owner,
          dirtyDraftContent: 'legacy draft',
          lastKnownDiskSignature: 'sig'
        }
      ]
    },
    unifiedTabs: {
      [KEY]: [
        editorTab('tab-other', { entityId: OTHER_PATH, executionHostId: LOCAL_EXECUTION_HOST_ID }),
        editorTab('tab-legacy', {
          entityId: FILE_PATH,
          executionHostId,
          isPinned: true,
          sortOrder: 1
        })
      ]
    },
    tabGroups: {
      [KEY]: [
        {
          id: 'group-1',
          worktreeId: KEY,
          activeTabId: 'tab-legacy',
          tabOrder: ['tab-other', 'tab-legacy']
        }
      ]
    },
    activeFileIdByWorktree: { [KEY]: FILE_PATH },
    activeTabTypeByWorktree: { [KEY]: 'editor' }
  }
}

// Mirrors use-app-startup-hydration.ts: four hydrators, then the boot reconcile.
function boot(session: WorkspaceSessionState) {
  const store = prepareStore()
  store.getState().hydrateWorkspaceSession(session)
  store.getState().hydrateTabsSession(session)
  store.getState().hydrateEditorSession(session)
  store.getState().hydrateBrowserSession(session)
  reconcileHydratedWorkspaceTabModels(session, store.getState().reconcileWorktreeTabModels)
  return store
}

function expectLegacyDraftView(store: ReturnType<typeof boot>) {
  const state = store.getState()
  const draftFiles = state.openFiles.filter((file) => file.filePath === FILE_PATH)
  expect(draftFiles).toHaveLength(1)
  const file = draftFiles[0]
  expect(state.editorDrafts[file.id]).toBe('legacy draft')
  expect(
    state.unifiedTabsByWorktree[KEY]?.map((tab) => [tab.id, tab.entityId, tab.isPinned ?? false])
  ).toEqual([
    ['tab-other', OTHER_PATH, false],
    ['tab-legacy', file.id, true]
  ])
  expect(state.groupsByWorktree[KEY]?.[0]?.activeTabId).toBe('tab-legacy')
  expect(state.activeFileIdByWorktree[KEY]).toBe(file.id)
}

describe('blocker 1: a legacy owned draft keeps its tab, pin and selection after the shared loader ids it', () => {
  const OWNERS: [string, Partial<PersistedOpenFile>, ExecutionHostId][] = [
    ['runtime-owned', { runtimeEnvironmentId: REMOTE_ENV }, toRuntimeExecutionHostId(REMOTE_ENV)],
    ['external-SSH-owned', { externalSshTargetId: 'ssh-1' }, toSshExecutionHostId('ssh-1')]
  ]

  it.each(OWNERS)('%s: renderer boot of the stored session', (_name, owner, hostId) => {
    expectLegacyDraftView(boot(legacyOwnedDraftSession(owner, hostId)))
  })

  it.each(OWNERS)(
    '%s: renderer boot of the shared save, then another save and restart',
    (_name, owner, hostId) => {
      const first = boot(sharedSave(legacyOwnedDraftSession(owner, hostId)))
      expectLegacyDraftView(first)
      const persisted = JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(first.getState())))
      expectLegacyDraftView(boot(sharedSave(persisted)))
    }
  )
})

/** A raw-path-id tab and an owned-id tab of one runtime-owned record, split or in one group. */
function rawPathTabCollisionSession(sameGroup: boolean, dirty: boolean): WorkspaceSessionState {
  const secondGroupId = sameGroup ? 'group-1' : 'group-2'
  const runtimeHostId = toRuntimeExecutionHostId(REMOTE_ENV)
  return {
    ...twinSession([dirty ? REMOTE_DIRTY : { runtimeEnvironmentId: REMOTE_ENV }]),
    unifiedTabs: {
      [KEY]: [
        editorTab(FILE_PATH, { entityId: FILE_PATH, executionHostId: runtimeHostId }),
        editorTab(REMOTE_FILE_ID, {
          entityId: REMOTE_FILE_ID,
          executionHostId: runtimeHostId,
          groupId: secondGroupId,
          sortOrder: 1,
          isPinned: true,
          customLabel: 'pinned copy',
          color: 'blue'
        })
      ]
    },
    tabGroups: {
      [KEY]: sameGroup
        ? [
            {
              id: 'group-1',
              worktreeId: KEY,
              activeTabId: FILE_PATH,
              tabOrder: [FILE_PATH, REMOTE_FILE_ID]
            }
          ]
        : [
            { id: 'group-1', worktreeId: KEY, activeTabId: FILE_PATH, tabOrder: [FILE_PATH] },
            {
              id: 'group-2',
              worktreeId: KEY,
              activeTabId: REMOTE_FILE_ID,
              tabOrder: [REMOTE_FILE_ID]
            }
          ]
    },
    tabGroupLayouts: {
      [KEY]: sameGroup
        ? { type: 'leaf', groupId: 'group-1' }
        : {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-1' },
            second: { type: 'leaf', groupId: 'group-2' }
          }
    }
  }
}

/** Each group's editor views of the one open file: [group, pinned, label, colour], tab ids distinct. */
function editorViewsByGroup(store: ReturnType<typeof boot>) {
  const state = store.getState()
  expect(state.openFiles).toHaveLength(1)
  const tabs = state.unifiedTabsByWorktree[KEY] ?? []
  expect(Object.values(state.editorDrafts)).toEqual(
    state.openFiles[0]?.isDirty ? [REMOTE_DIRTY.dirtyDraftContent] : []
  )
  expect(new Set(tabs.map((tab) => tab.id)).size).toBe(tabs.length)
  for (const group of state.groupsByWorktree[KEY] ?? []) {
    expect(group.tabOrder).toEqual(
      tabs.filter((tab) => tab.groupId === group.id).map((tab) => tab.id)
    )
    expect(group.activeTabId === null || group.tabOrder.includes(group.activeTabId)).toBe(true)
  }
  return tabs.map((tab) => {
    expect(tab.entityId).toBe(state.openFiles[0]?.id)
    return [tab.groupId, tab.isPinned ?? false, tab.customLabel, tab.color]
  })
}

function restart(store: ReturnType<typeof boot>) {
  return boot(JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(store.getState()))))
}

describe('blocker 3: a migrated raw-path tab id cannot collapse split views or drop a pin', () => {
  const ROUTES: [string, boolean, (session: WorkspaceSessionState) => WorkspaceSessionState][] = [
    ['stored clean session', false, (session) => session],
    ['shared save of a clean record', false, sharedSave],
    ['stored draft session', true, (session) => session],
    ['shared save of a draft record', true, sharedSave]
  ]

  it.each(ROUTES)('%s: views in two groups both survive restart', (_name, dirty, route) => {
    const expected = [
      ['group-1', false, null, null],
      ['group-2', true, 'pinned copy', 'blue']
    ]
    const first = boot(route(rawPathTabCollisionSession(false, dirty)))
    expect(editorViewsByGroup(first)).toEqual(expected)
    expect(editorViewsByGroup(restart(first))).toEqual(expected)
  })

  it.each(ROUTES)(
    '%s: one group keeps the pinned copy with its decoration',
    (_name, dirty, route) => {
      const expected = [['group-1', true, 'pinned copy', 'blue']]
      const first = boot(route(rawPathTabCollisionSession(true, dirty)))
      expect(editorViewsByGroup(first)).toEqual(expected)
      expect(first.getState().groupsByWorktree[KEY]?.[0]?.activeTabId).toBe(
        first.getState().unifiedTabsByWorktree[KEY]?.[0]?.id
      )
      expect(editorViewsByGroup(restart(first))).toEqual(expected)
    }
  )
})
