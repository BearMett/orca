import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { collectFolderWorkspaceKeysFromSession } from '@/lib/workspace-session-hydration-keys'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { reconcileHydratedWorkspaceTabModels } from '../../app-shell/reconcile-hydrated-workspace-tab-models'
import type { OpenFile } from './editor'
import { buildOwnedEditorFileId } from './editor/file-ids/editor-file-ids'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { createTestStore, makeTab, makeUnifiedTab, makeWorktree } from './store-test-helpers'
import {
  buildStaleEditorTabSession,
  STALE_TAB_BRAND_COMPOSITE_TAB_ID,
  STALE_TAB_BRAND_PATH,
  STALE_TAB_CSV_PATH,
  STALE_TAB_CSV_TAB_ID,
  STALE_TAB_GROUP_ID,
  STALE_TAB_REPO_ID,
  STALE_TAB_RUNTIME_ENV_ID,
  STALE_TAB_WORKTREE_ID,
  STALE_TAB_WORKTREE_PATH
} from './stale-editor-tab-resurrection-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const WT = STALE_TAB_WORKTREE_ID
const RUNTIME_HOST_ID: ExecutionHostId = `runtime:${STALE_TAB_RUNTIME_ENV_ID}`
const BRAND_RELATIVE_PATH = 'sandbox/2026-09-16-listings-survey/handout/brand-requests.txt'
const CSV_RELATIVE_PATH = 'sandbox/2026-09-14-kahi-e2e-data-survey/kahi-2026-07-qty-by-listing.csv'
const TERMINAL_IDS = ['terminal-seven', 'terminal-nine']

const FOLDER_ID = 'folder-1'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_ID)
const FOLDER_FILE_PATH = '/srv/work/notes.md'
const FOLDER_OTHER_PATH = '/srv/work/other.md'

type TestStore = ReturnType<typeof createTestStore>

function prepareStore(
  hostIds: readonly ExecutionHostId[],
  focusedHostId: ExecutionHostId | null = hostIds[0] ?? null
): TestStore {
  const store = createTestStore()
  store.setState({
    repos: [
      {
        id: STALE_TAB_REPO_ID,
        path: STALE_TAB_WORKTREE_PATH,
        displayName: 'eppo',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    worktreesByRepo: {
      [STALE_TAB_REPO_ID]: hostIds.map((hostId) =>
        makeWorktree({ id: WT, repoId: STALE_TAB_REPO_ID, path: STALE_TAB_WORKTREE_PATH, hostId })
      )
    },
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: focusedHostId
  })
  return store
}

function prepareFolderStore(executionHostId?: ExecutionHostId): TestStore {
  const store = createTestStore()
  store.setState({
    folderWorkspaces: [
      {
        id: FOLDER_ID,
        projectGroupId: 'project-group-1',
        name: 'Folder',
        folderPath: '/srv/work',
        connectionId: null,
        ...(executionHostId ? { executionHostId } : {}),
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    projectGroups: [],
    activeWorktreeId: FOLDER_KEY,
    activeWorkspaceExecutionHostId: RUNTIME_HOST_ID
  })
  return store
}

// Mirrors use-app-startup-hydration.ts: four hydrators, then the boot reconcile.
function boot(store: TestStore, session: WorkspaceSessionState) {
  const options = { additionalValidWorkspaceKeys: collectFolderWorkspaceKeysFromSession(session) }
  store.getState().hydrateWorkspaceSession(session, options)
  store.getState().hydrateTabsSession(session, options)
  store.getState().hydrateEditorSession(session, options)
  store.getState().hydrateBrowserSession(session, options)
  reconcileHydratedWorkspaceTabModels(session, store.getState().reconcileWorktreeTabModels)
  return store.getState()
}

function persist(store: TestStore): WorkspaceSessionState {
  return JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(store.getState())))
}

function brandRow(overrides: Partial<PersistedOpenFile> = {}): PersistedOpenFile {
  return {
    filePath: STALE_TAB_BRAND_PATH,
    relativePath: BRAND_RELATIVE_PATH,
    worktreeId: WT,
    language: 'plaintext',
    runtimeEnvironmentId: null,
    ...overrides
  }
}

function csvRow(overrides: Partial<PersistedOpenFile> = {}): PersistedOpenFile {
  return {
    filePath: STALE_TAB_CSV_PATH,
    relativePath: CSV_RELATIVE_PATH,
    worktreeId: WT,
    language: 'csv',
    runtimeEnvironmentId: null,
    ...overrides
  }
}

function fixtureWithRows(rows: PersistedOpenFile[]): WorkspaceSessionState {
  const session = buildStaleEditorTabSession()
  session.openFilesByWorktree = { [WT]: rows }
  return session
}

function filesAt(state: { openFiles: OpenFile[] }, filePath: string): OpenFile[] {
  return state.openFiles.filter((file) => file.filePath === filePath)
}

// Recovery may land on a survivor or in the reopen stack; either keeps the user's text.
function draftIsRecoverable(
  state: ReturnType<TestStore['getState']>,
  workspaceId: string,
  draft: string
): boolean {
  return (
    Object.values(state.editorDrafts).includes(draft) ||
    JSON.stringify(state.recentlyClosedEditorTabsByWorktree[workspaceId] ?? []).includes(
      JSON.stringify(draft)
    )
  )
}

function liveFile(id: string): OpenFile {
  return {
    id,
    filePath: STALE_TAB_BRAND_PATH,
    relativePath: BRAND_RELATIVE_PATH,
    worktreeId: WT,
    language: 'plaintext',
    mode: 'edit',
    isDirty: false,
    isPreview: false,
    runtimeEnvironmentId: null
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('case 1: save-time dedupe', () => {
  it('preserves distinct backing record IDs for the same document', () => {
    const store = prepareStore(['local'])
    store.setState({ openFiles: [liveFile(STALE_TAB_BRAND_PATH), liveFile('editor:second-pane')] })

    const written = persist(store)

    expect(written.openFilesByWorktree?.[WT]?.map((file) => file.id)).toEqual([
      STALE_TAB_BRAND_PATH,
      'editor:second-pane'
    ])
  })
})

describe('case 2: draft preference at hydration', () => {
  it('keeps the dirty draft carried by the second of two same-owner records', () => {
    const state = boot(
      prepareStore(['local']),
      fixtureWithRows([brandRow(), brandRow({ dirtyDraftContent: 'unsaved second draft' })])
    )

    expect(filesAt(state, STALE_TAB_BRAND_PATH)).toHaveLength(1)
    expect(draftIsRecoverable(state, WT, 'unsaved second draft')).toBe(true)
  })
})

describe('case 3: owner normalisation (git worktree)', () => {
  it('premise: the resolver places a local, local-focused worktree on the local route', () => {
    const store = prepareStore(['local'])
    expect(resolveWorktreeOperationRouteResult(store.getState(), WT)).toEqual({
      kind: 'resolved',
      route: { executionHostId: 'local', runtimeEnvironmentId: null }
    })
  })

  it('preserves both owners when the current route is local', () => {
    const state = boot(
      prepareStore(['local']),
      fixtureWithRows([brandRow(), brandRow({ runtimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID })])
    )

    expect(filesAt(state, STALE_TAB_BRAND_PATH).map((file) => file.runtimeEnvironmentId)).toEqual([
      null,
      STALE_TAB_RUNTIME_ENV_ID
    ])
  })

  it('keeps the divergent dirty draft of the runtime-owned record', () => {
    const state = boot(
      prepareStore(['local']),
      fixtureWithRows([
        brandRow(),
        brandRow({
          runtimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID,
          dirtyDraftContent: 'runtime pane draft'
        })
      ])
    )

    expect(draftIsRecoverable(state, WT, 'runtime pane draft')).toBe(true)
  })

  it('premise: the resolver places a runtime-hosted worktree on its runtime route', () => {
    const store = prepareStore([RUNTIME_HOST_ID])
    expect(resolveWorktreeOperationRouteResult(store.getState(), WT)).toEqual({
      kind: 'resolved',
      route: { executionHostId: RUNTIME_HOST_ID, runtimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID }
    })
  })

  it('preserves both owners when the current route is runtime', () => {
    const state = boot(
      prepareStore([RUNTIME_HOST_ID]),
      fixtureWithRows([brandRow(), brandRow({ runtimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID })])
    )

    expect(filesAt(state, STALE_TAB_BRAND_PATH).map((file) => file.runtimeEnvironmentId)).toEqual([
      null,
      STALE_TAB_RUNTIME_ENV_ID
    ])
  })

  it('keeps both owners verbatim when the worktree is listed on two hosts', () => {
    const state = boot(
      prepareStore(['local', RUNTIME_HOST_ID], null),
      fixtureWithRows([brandRow(), brandRow({ runtimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID })])
    )

    expect(filesAt(state, STALE_TAB_BRAND_PATH).map((file) => file.runtimeEnvironmentId)).toEqual([
      null,
      STALE_TAB_RUNTIME_ENV_ID
    ])
  })
})

function folderSession(rows: PersistedOpenFile[], tabbedPaths: string[]): WorkspaceSessionState {
  const groupId = 'folder-group'
  const tabs = tabbedPaths.map((filePath, index) =>
    makeUnifiedTab({
      id: `folder-tab-${index}`,
      entityId: filePath,
      groupId,
      worktreeId: FOLDER_KEY,
      contentType: 'editor',
      label: filePath.split('/').at(-1) ?? filePath,
      sortOrder: index
    })
  )
  return {
    activeRepoId: null,
    activeWorktreeId: FOLDER_KEY,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: { [FOLDER_KEY]: rows },
    activeFileIdByWorktree: { [FOLDER_KEY]: tabbedPaths[0] ?? null },
    activeTabTypeByWorktree: { [FOLDER_KEY]: 'editor' },
    unifiedTabs: { [FOLDER_KEY]: tabs },
    tabGroups: {
      [FOLDER_KEY]: [
        {
          id: groupId,
          worktreeId: FOLDER_KEY,
          activeTabId: tabs[0]?.id ?? null,
          tabOrder: tabs.map((tab) => tab.id)
        }
      ]
    },
    activeGroupIdByWorktree: { [FOLDER_KEY]: groupId }
  }
}

function folderRow(
  filePath: string,
  runtimeEnvironmentId: string | null,
  overrides: Partial<PersistedOpenFile> = {}
): PersistedOpenFile {
  return {
    filePath,
    relativePath: filePath.split('/').at(-1) ?? filePath,
    worktreeId: FOLDER_KEY,
    language: 'markdown',
    runtimeEnvironmentId,
    ...overrides
  }
}

describe('case 3: owner normalisation (folder workspace)', () => {
  it('preserves both owners in a folder workspace stamped as local', () => {
    const state = boot(
      prepareFolderStore('local'),
      folderSession(
        [folderRow(FOLDER_FILE_PATH, null), folderRow(FOLDER_FILE_PATH, STALE_TAB_RUNTIME_ENV_ID)],
        [FOLDER_FILE_PATH]
      )
    )

    expect(filesAt(state, FOLDER_FILE_PATH).map((file) => file.runtimeEnvironmentId)).toEqual([
      null,
      STALE_TAB_RUNTIME_ENV_ID
    ])
  })

  it('keeps both owners of an unstamped folder workspace, focus notwithstanding', () => {
    const state = boot(
      prepareFolderStore(),
      folderSession(
        [folderRow(FOLDER_FILE_PATH, null), folderRow(FOLDER_FILE_PATH, STALE_TAB_RUNTIME_ENV_ID)],
        [FOLDER_FILE_PATH]
      )
    )

    expect(filesAt(state, FOLDER_FILE_PATH).map((file) => file.runtimeEnvironmentId)).toEqual([
      null,
      STALE_TAB_RUNTIME_ENV_ID
    ])
  })
})

function brandEditorTabs(state: ReturnType<TestStore['getState']>) {
  const brandIds = new Set(filesAt(state, STALE_TAB_BRAND_PATH).map((file) => file.id))
  return (state.unifiedTabsByWorktree[WT] ?? []).filter(
    (tab) => tab.contentType === 'editor' && brandIds.has(tab.entityId)
  )
}

describe('case 4: plain-path tab next to an owned-id tab', () => {
  it('fixture as-is: the two brand tabs collapse to one', () => {
    const state = boot(prepareStore(['local']), buildStaleEditorTabSession())

    expect(brandEditorTabs(state)).toHaveLength(1)
  })

  it('collapses the plain-path tab onto the owned-id tab after file-id migration', () => {
    const ownedBrandId = buildOwnedEditorFileId(STALE_TAB_BRAND_PATH, WT, STALE_TAB_RUNTIME_ENV_ID)
    expect(ownedBrandId).toBe(STALE_TAB_BRAND_COMPOSITE_TAB_ID)
    const session = fixtureWithRows([brandRow({ runtimeEnvironmentId: STALE_TAB_RUNTIME_ENV_ID })])
    session.unifiedTabs![WT] = session
      .unifiedTabs![WT]!.filter((tab) => tab.id !== STALE_TAB_CSV_TAB_ID)
      .map((tab) =>
        tab.id === STALE_TAB_BRAND_COMPOSITE_TAB_ID ? { ...tab, entityId: ownedBrandId } : tab
      )

    const state = boot(prepareStore(['local']), session)

    expect(filesAt(state, STALE_TAB_BRAND_PATH).map((file) => file.id)).toEqual([ownedBrandId])
    expect(brandEditorTabs(state).map((tab) => tab.id)).toHaveLength(1)
  })
})

function terminalRows(workspaceId: string) {
  return TERMINAL_IDS.map((id, index) =>
    makeTab({ id, worktreeId: workspaceId, title: `Terminal ${index}`, createdAt: 1 })
  )
}

function terminalUnifiedTabs(workspaceId: string, groupId: string) {
  return TERMINAL_IDS.map((id) =>
    makeUnifiedTab({ id, worktreeId: workspaceId, groupId, contentType: 'terminal', createdAt: 1 })
  )
}

// csv has a tab and is active; brand has a record but no tab anywhere.
function reverseOrphanSession(
  brand: PersistedOpenFile,
  withTerminals: boolean
): WorkspaceSessionState {
  const session = fixtureWithRows([csvRow(), brand])
  const csvTab = { ...session.unifiedTabs![WT]![0]!, entityId: STALE_TAB_CSV_PATH }
  const terminals = withTerminals ? terminalUnifiedTabs(WT, STALE_TAB_GROUP_ID) : []
  session.unifiedTabs = { [WT]: [...terminals, csvTab] }
  session.tabsByWorktree = withTerminals ? { [WT]: terminalRows(WT) } : {}
  session.tabGroups = {
    [WT]: [
      {
        id: STALE_TAB_GROUP_ID,
        worktreeId: WT,
        activeTabId: csvTab.id,
        tabOrder: [...terminals.map((tab) => tab.id), csvTab.id]
      }
    ]
  }
  session.activeFileIdByWorktree = { [WT]: STALE_TAB_CSV_PATH }
  session.activeTabTypeByWorktree = { [WT]: 'editor' }
  return session
}

describe('case 5: reverse orphan open file at boot', () => {
  it('preserves a clean record without evidence of closure in an editor-only worktree', () => {
    const state = boot(prepareStore(['local']), reverseOrphanSession(brandRow(), false))

    expect(filesAt(state, STALE_TAB_CSV_PATH)).toHaveLength(1)
    expect(filesAt(state, STALE_TAB_BRAND_PATH)).toHaveLength(1)
  })

  it('preserves a clean record without evidence of closure in a worktree that also has terminal rows', () => {
    const state = boot(prepareStore(['local']), reverseOrphanSession(brandRow(), true))

    expect(filesAt(state, STALE_TAB_CSV_PATH)).toHaveLength(1)
    expect(filesAt(state, STALE_TAB_BRAND_PATH)).toHaveLength(1)
  })

  it('keeps a dirty untabbed record in an editor-only worktree', () => {
    const state = boot(
      prepareStore(['local']),
      reverseOrphanSession(brandRow({ dirtyDraftContent: 'orphan draft' }), false)
    )

    expect(filesAt(state, STALE_TAB_BRAND_PATH)).toHaveLength(1)
    expect(Object.values(state.editorDrafts)).toContain('orphan draft')
  })

  it('preserves a clean record without evidence of closure in an editor-only folder workspace', () => {
    const state = boot(
      prepareFolderStore('local'),
      folderSession(
        [folderRow(FOLDER_FILE_PATH, null), folderRow(FOLDER_OTHER_PATH, null)],
        [FOLDER_FILE_PATH]
      )
    )

    expect(filesAt(state, FOLDER_FILE_PATH)).toHaveLength(1)
    expect(filesAt(state, FOLDER_OTHER_PATH)).toHaveLength(1)
  })

  it('keeps a dirty untabbed record in an editor-only folder workspace', () => {
    const state = boot(
      prepareFolderStore('local'),
      folderSession(
        [
          folderRow(FOLDER_FILE_PATH, null),
          folderRow(FOLDER_OTHER_PATH, null, { dirtyDraftContent: 'folder orphan draft' })
        ],
        [FOLDER_FILE_PATH]
      )
    )

    expect(filesAt(state, FOLDER_OTHER_PATH)).toHaveLength(1)
    expect(Object.values(state.editorDrafts)).toContain('folder orphan draft')
  })
})

function closeRestartSession(): WorkspaceSessionState {
  const session = buildStaleEditorTabSession()
  const terminals = terminalUnifiedTabs(WT, STALE_TAB_GROUP_ID).map((tab) => ({
    ...tab,
    executionHostId: RUNTIME_HOST_ID
  }))
  const editorTabs = session.unifiedTabs![WT]!
  session.tabsByWorktree = { [WT]: terminalRows(WT) }
  session.unifiedTabs = { [WT]: [...terminals, ...editorTabs] }
  session.tabGroups = {
    [WT]: [
      {
        id: STALE_TAB_GROUP_ID,
        worktreeId: WT,
        activeTabId: TERMINAL_IDS[0]!,
        tabOrder: [...TERMINAL_IDS, ...editorTabs.map((tab) => tab.id)],
        recentTabIds: [...editorTabs.map((tab) => tab.id), ...TERMINAL_IDS]
      }
    ]
  }
  return session
}

function terminalTabs(state: ReturnType<TestStore['getState']>) {
  return (state.unifiedTabsByWorktree[WT] ?? []).filter((tab) => tab.contentType === 'terminal')
}

// Closes what the user sees: every visible editor tab of the brand document.
function closeVisibleBrandTabs(store: TestStore): void {
  for (const tab of brandEditorTabs(store.getState())) {
    if (store.getState().openFiles.some((file) => file.id === tab.entityId)) {
      store.getState().closeFile(tab.entityId)
    }
  }
}

function restartThreeTimes(store: TestStore) {
  const states: ReturnType<TestStore['getState']>[] = []
  let current = store
  for (let restart = 0; restart < 3; restart++) {
    const next = prepareStore(['local'])
    states.push(boot(next, persist(current)))
    current = next
  }
  return states
}

describe('case 8: close, persist, restore loop on the fixture', () => {
  it('control: terminal tabs survive three restarts without any close', () => {
    const store = prepareStore(['local'])
    const baseline = terminalTabs(boot(store, closeRestartSession()))
    expect(baseline.map((tab) => tab.id)).toEqual(TERMINAL_IDS)

    for (const state of restartThreeTimes(store)) {
      expect(terminalTabs(state)).toEqual(baseline)
    }
  })

  it('closed brand document never returns as a visible tab', () => {
    const store = prepareStore(['local'])
    boot(store, closeRestartSession())
    closeVisibleBrandTabs(store)
    expect(brandEditorTabs(store.getState())).toEqual([])

    for (const state of restartThreeTimes(store)) {
      expect(brandEditorTabs(state)).toEqual([])
    }
  })

  it('closing the local document preserves the separate runtime-owned record', () => {
    const store = prepareStore(['local'])
    boot(store, closeRestartSession())
    closeVisibleBrandTabs(store)

    for (const state of restartThreeTimes(store)) {
      expect(filesAt(state, STALE_TAB_BRAND_PATH).map((file) => file.runtimeEnvironmentId)).toEqual(
        [STALE_TAB_RUNTIME_ENV_ID]
      )
    }
  })

  it('terminal tabs and the untouched csv survive the close loop', () => {
    const store = prepareStore(['local'])
    const baseline = terminalTabs(boot(store, closeRestartSession()))
    closeVisibleBrandTabs(store)

    for (const state of restartThreeTimes(store)) {
      expect(terminalTabs(state)).toEqual(baseline)
      expect(filesAt(state, STALE_TAB_CSV_PATH)).toHaveLength(1)
    }
  })
})
