import { beforeAll, describe, expect, it } from 'vitest'
import type { WebSessionTabsSyncState } from '../../../src/renderer/src/runtime/web-session-tabs-sync/state'
import type { OpenFile } from '../../../src/renderer/src/store/slices/editor/types/open-file'
import { getDefaultWorkspaceSession } from '../../../src/shared/constants'
import type { RuntimeMobileSessionMarkdownTab } from '../../../src/shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-session-contracts'
import { projectSessionTabs } from '../../../src/shared/workspace-layout/old-client'
import { WS } from '../../../src/shared/workspace-layout/workspace-layout-command.test-fixture'
import { loadWorkspaceLayout } from '../../../src/shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../src/shared/workspace-layout/workspace-layout-minted-ids'
import type { PersistedOpenFile } from '../../../src/shared/workspace-session-state-types'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

/**
 * The old-client projection now publishes a markdown row's `sourceFileId` as the tab's editor
 * record id (opaque, e.g. a UUID or `runtime-file`) instead of its file path. Released receivers
 * must read such a row exactly as they read the path-valued one: same OpenFile ids, paths,
 * dirty flags and tabs. Each cell applies a record-id frame and a path-valued control through
 * one build and requires deep equality, so a pass means "the field is inert", not "no crash".
 */
// Pinned releases plus the newest stable tag (or ORCA_CROSS_VERSION_BASELINE_REF) seen by this run.
const OLD_REFS = [...new Set(['v1.4.204', 'v1.4.215', resolveBaselineReleaseRef()])]
const SUITE_TIMEOUT_MS = 180_000
const ENV = 'env-host'
const NOW = 1_700_000_000_000
const PATH = '/repo/note.md'
const SNAPSHOT_API = 'src/renderer/src/runtime/web-session-tabs-sync/snapshot-api.ts'
const TRACKING = 'src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle.ts'

type Apply = (
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now: number
) => Partial<WebSessionTabsSyncState>

type Receiver = { label: string; apply: Apply; resetFreshness: () => void }

function requireFunction<T>(module: Record<string, unknown>, name: string, label: string): T {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`${label}: ${name} is not exported as a function`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the export was just checked to be a function; its signature is pinned by the shared wire contract this spec drives.
  return value as T
}

function toReceiver(
  label: string,
  snapshotApi: Record<string, unknown>,
  tracking: Record<string, unknown>
): Receiver {
  return {
    label,
    apply: requireFunction<Apply>(snapshotApi, 'applyWebSessionTabsSnapshot', label),
    resetFreshness: requireFunction(tracking, 'resetWebSessionTabsSnapshotFreshnessForTests', label)
  }
}

async function loadReceiver(ref: string | null): Promise<Receiver> {
  if (ref === null) {
    const [snapshotApi, tracking] = await Promise.all([
      import('../../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'),
      import('../../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle')
    ])
    return toReceiver('stack', snapshotApi, tracking)
  }
  const checkout = await materializeReleaseCheckout(ref)
  const [snapshotApi, tracking] = await Promise.all([
    importReleaseCheckoutModule(checkout, SNAPSHOT_API),
    importReleaseCheckoutModule(checkout, TRACKING)
  ])
  return toReceiver(`${ref}@${checkout.commit.slice(0, 10)}`, snapshotApi, tracking)
}

type Owner = { id: string; runtimeEnvironmentId: string | null; dirty: boolean }

function record(owner: Owner): PersistedOpenFile {
  return {
    id: owner.id,
    filePath: PATH,
    relativePath: 'note.md',
    worktreeId: WS,
    language: 'markdown',
    runtimeEnvironmentId: owner.runtimeEnvironmentId,
    ...(owner.dirty ? { dirtyDraftContent: `${owner.id}-draft` } : {}),
    lastKnownDiskSignature: `${owner.id}-baseline`
  }
}

/** Tab ids are positional so two layouts differing only in record ids publish the same tabs. */
function projectFrame(owners: Owner[]): RuntimeMobileSessionTabsResult {
  const tabIds = owners.map((_, index) => `tab-${index}`)
  const model = loadWorkspaceLayout(
    'local',
    {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: { [WS]: owners.map(record) },
      unifiedTabs: {
        [WS]: owners.map((owner, index) => ({
          id: tabIds[index]!,
          entityId: owner.id,
          worktreeId: WS,
          groupId: 'g',
          contentType: 'editor' as const,
          label: 'note.md',
          customLabel: null,
          color: null,
          sortOrder: index,
          createdAt: 0
        }))
      },
      tabGroups: { [WS]: [{ id: 'g', worktreeId: WS, activeTabId: tabIds[0]!, tabOrder: tabIds }] }
    },
    nameBasedLoadContext()
  )
  const projected = projectSessionTabs(
    WS,
    model.layout.workspaces[WS]!,
    model.desktopView,
    model.facts,
    false
  )
  const tabs = projected.tabs.map((tab) => {
    if (tab.type === 'terminal') {
      throw new Error(`unexpected terminal row ${tab.id}`)
    }
    return tab
  })
  return { ...projected, tabs, publicationEpoch: 'epoch-1', snapshotVersion: 1 }
}

function markdownRows(frame: RuntimeMobileSessionTabsResult): RuntimeMobileSessionMarkdownTab[] {
  return frame.tabs.filter((tab): tab is RuntimeMobileSessionMarkdownTab => tab.type === 'markdown')
}

/** The wire this branch replaced: every markdown row's sourceFileId is its source path. */
function withPathSourceIds(frame: RuntimeMobileSessionTabsResult): RuntimeMobileSessionTabsResult {
  return {
    ...frame,
    tabs: frame.tabs.map((tab) =>
      tab.type === 'markdown' ? { ...tab, sourceFileId: tab.sourceFilePath } : tab
    )
  }
}

function asPreview(frame: RuntimeMobileSessionTabsResult): RuntimeMobileSessionTabsResult {
  return {
    ...frame,
    tabs: frame.tabs.map((tab) =>
      tab.type === 'markdown' ? { ...tab, mode: 'markdown-preview' as const } : tab
    )
  }
}

function emptySyncState(): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WS,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0
  }
}

type Received = { files: OpenFile[]; tabs: unknown[] }

/** Fresh state and freshness per apply, so the control is never dropped as a stale replay. */
function receive(receiver: Receiver, frame: RuntimeMobileSessionTabsResult): Received {
  receiver.resetFreshness()
  const patch = receiver.apply(emptySyncState(), frame, ENV, NOW)
  expect(patch.openFiles, `${receiver.label} returned no openFiles patch`).toBeDefined()
  expect(patch.unifiedTabsByWorktree?.[WS], `${receiver.label} returned no tabs`).toBeDefined()
  return {
    files: (patch.openFiles ?? []).filter((file) => file.worktreeId === WS),
    tabs: (patch.unifiedTabsByWorktree?.[WS] ?? []).filter((tab) => tab.contentType === 'editor')
  }
}

function summary(received: Received) {
  return received.files.map(({ id, filePath, isDirty, mode, markdownPreviewSourceFileId }) => ({
    id,
    filePath,
    isDirty,
    mode,
    markdownPreviewSourceFileId
  }))
}

const RECORD_ID = '3f2c9a4e-6b1d-4c8e-9f7a-1d2e3c4b5a69'
const singleRecordId: Owner[] = [{ id: RECORD_ID, runtimeEnvironmentId: null, dirty: true }]
const singlePathId: Owner[] = [{ id: PATH, runtimeEnvironmentId: null, dirty: true }]
const twoOwners: Owner[] = [
  { id: 'local-file', runtimeEnvironmentId: null, dirty: true },
  { id: 'runtime-file', runtimeEnvironmentId: 'remote', dirty: false }
]

const receivers: Receiver[] = []

beforeAll(async () => {
  receivers.push(...(await Promise.all([...OLD_REFS, null].map(loadReceiver))))
}, SUITE_TIMEOUT_MS)

describe('cross-version session-tabs markdown sourceFileId as a record id', () => {
  it('pairs the stack projection against distinct released receivers', () => {
    expect(receivers.map((receiver) => receiver.label.split('@')[0])).toEqual([
      ...OLD_REFS,
      'stack'
    ])
    // Builds resolving to one module would make every cell a same-version run.
    expect(new Set(receivers.map((receiver) => receiver.apply)).size).toBe(receivers.length)
  })

  it('publishes the record id as sourceFileId and the path everywhere a receiver keys on', () => {
    const recordFrame = projectFrame(singleRecordId)
    const pathFrame = projectFrame(singlePathId)
    expect(markdownRows(recordFrame)).toMatchObject([
      { filePath: PATH, sourceFileId: RECORD_ID, sourceFilePath: PATH, isDirty: true }
    ])
    expect(markdownRows(pathFrame)).toMatchObject([{ sourceFileId: PATH }])
    // The only wire difference between a record-id owner and a legacy path-id owner.
    expect(withPathSourceIds(recordFrame)).toEqual(pathFrame)
  })

  it('every receiver reads a record-id row exactly as the legacy path-id row', () => {
    const recordFrame = projectFrame(singleRecordId)
    const pathFrame = projectFrame(singlePathId)
    for (const receiver of receivers) {
      const fromRecord = receive(receiver, recordFrame)
      const fromPath = receive(receiver, pathFrame)
      console.info(
        `[record-id sourceFileId] single owner ${receiver.label}`,
        JSON.stringify({ record: summary(fromRecord), path: summary(fromPath) })
      )
      expect(fromRecord, receiver.label).toEqual(fromPath)
      expect(summary(fromRecord), receiver.label).toEqual([
        {
          id: PATH,
          filePath: PATH,
          isDirty: true,
          mode: 'edit',
          markdownPreviewSourceFileId: undefined
        }
      ])
      expect(fromRecord.tabs, receiver.label).toMatchObject([{ id: 'tab-0', entityId: PATH }])
    }
  })

  it('two owners of one path: every receiver matches the path-valued wire it read before', () => {
    const recordFrame = projectFrame(twoOwners)
    expect(markdownRows(recordFrame).map((row) => [row.id, row.sourceFileId, row.isDirty])).toEqual(
      [
        ['tab-0', 'local-file', true],
        ['tab-1', 'runtime-file', false]
      ]
    )
    const pathFrame = withPathSourceIds(recordFrame)
    for (const receiver of receivers) {
      const fromRecord = receive(receiver, recordFrame)
      const fromPath = receive(receiver, pathFrame)
      // Characterization: both rows key on the shared path, as they did before this branch.
      console.info(
        `[record-id sourceFileId] two owners ${receiver.label}`,
        JSON.stringify({ files: summary(fromRecord), tabs: fromRecord.tabs })
      )
      expect(fromRecord, receiver.label).toEqual(fromPath)
      for (const file of fromRecord.files) {
        expect(file.filePath, receiver.label).toBe(PATH)
        expect(['local-file', 'runtime-file'], receiver.label).not.toContain(file.id)
      }
      expect(fromRecord.tabs.length, receiver.label).toBe(2)
    }
  })

  it('a preview-mode row still keys on sourceFilePath, never the record id', () => {
    const recordFrame = asPreview(projectFrame(singleRecordId))
    const pathFrame = withPathSourceIds(recordFrame)
    for (const receiver of receivers) {
      const fromRecord = receive(receiver, recordFrame)
      expect(fromRecord, receiver.label).toEqual(receive(receiver, pathFrame))
      expect(summary(fromRecord), receiver.label).toMatchObject([
        { id: `markdown-preview::${PATH}`, filePath: PATH, markdownPreviewSourceFileId: PATH }
      ])
    }
  })
})
