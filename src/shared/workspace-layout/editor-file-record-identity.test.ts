import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../constants'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import { editorFileRecordKey } from './editor-file-record-identity'
import { preservePersistedEditorFileRecords } from './persisted-editor-file-records'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { saveWorkspaceLayout } from './workspace-layout-save'
import { applyLayoutCommand } from './workspace-layout-commands'
import { testContext, WS } from './workspace-layout-command.test-fixture'
import { projectSessionTabs } from './old-client'
import { pruneViewRecord } from './workspace-layout-view-prune'

const PATH = '/repo/note.md'
function record(id: string, runtimeEnvironmentId: string | null): PersistedOpenFile {
  return {
    id,
    filePath: PATH,
    relativePath: 'note.md',
    worktreeId: WS,
    language: 'markdown',
    runtimeEnvironmentId,
    dirtyDraftContent: `${id}-draft`,
    lastKnownDiskSignature: `${id}-baseline`
  }
}
function loaded() {
  return loadWorkspaceLayout(
    'local',
    {
      ...getDefaultWorkspaceSession(),
      openFilesByWorktree: { [WS]: [record('local-file', null), record('runtime-file', 'remote')] },
      unifiedTabs: {
        [WS]: ['local-file', 'runtime-file'].map((id) => ({
          id: `tab-${id}`,
          entityId: id,
          worktreeId: WS,
          groupId: 'g',
          contentType: 'editor' as const,
          label: 'note.md',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }))
      },
      tabGroups: {
        [WS]: [
          {
            id: 'g',
            worktreeId: WS,
            activeTabId: 'tab-local-file',
            tabOrder: ['tab-local-file', 'tab-runtime-file']
          }
        ]
      }
    },
    nameBasedLoadContext()
  )
}

describe('editor record identity through shared commands and publication', () => {
  it('keeps both owners in the old-client projection with their actual file paths', () => {
    const model = loaded()
    const projected = projectSessionTabs(
      WS,
      model.layout.workspaces[WS]!,
      model.desktopView,
      model.facts,
      false
    )
    expect(projected.tabs.map((tab) => tab.id)).toEqual(['tab-local-file', 'tab-runtime-file'])
    for (const tab of projected.tabs) {
      expect(tab).toMatchObject({ type: 'markdown', filePath: PATH, isDirty: true })
    }
    expect(projected.tabs[1]).toMatchObject({ sourceFileId: 'runtime-file' })
    const pruned = pruneViewRecord(model.desktopView, model.layout)
    expect(pruned.editorDrafts[WS]).toEqual(model.desktopView.editorDrafts[WS])
    expect(
      saveWorkspaceLayout({ ...model, desktopView: pruned }).openFilesByWorktree?.[WS]
    ).toEqual([record('local-file', null), record('runtime-file', 'remote')])
  })

  it('closing one owner keeps the other file and draft', () => {
    const model = loaded()
    const result = applyLayoutCommand(
      model.layout,
      {
        type: 'closeTabs',
        workspace: WS,
        tabIds: ['tab-local-file'],
        force: true
      },
      testContext()
    )
    if (!result.ok) {
      throw new Error(result.code)
    }
    const desktopView = pruneViewRecord(model.desktopView, result.model)
    const saved = saveWorkspaceLayout({ ...model, layout: result.model, desktopView })
    expect(saved.openFilesByWorktree?.[WS]).toEqual([record('runtime-file', 'remote')])
    expect(Object.keys(desktopView.editorDrafts[WS] ?? {})).toEqual(['runtime-file'])
  })

  it('opening another view updates only its backing record', () => {
    const model = loaded()
    const closed = applyLayoutCommand(
      model.layout,
      {
        type: 'closeTabs',
        workspace: WS,
        tabIds: ['tab-local-file'],
        force: true
      },
      testContext()
    )
    if (!closed.ok) {
      throw new Error(closed.code)
    }
    const result = applyLayoutCommand(
      closed.model,
      {
        type: 'openEditorTab',
        workspace: WS,
        fileId: 'local-file',
        contentType: 'editor',
        file: {
          id: 'local-file',
          filePath: PATH,
          relativePath: 'note.md',
          language: 'markdown',
          runtimeEnvironmentId: null
        }
      },
      testContext()
    )
    if (!result.ok) {
      throw new Error(result.code)
    }
    expect(result.model.workspaces[WS]?.editorFiles?.map((file) => file.id)).toEqual([
      'runtime-file',
      'local-file'
    ])
  })
})

describe('persisted editor record normalization', () => {
  it('separates a malformed ID reused by different owners without losing either draft', () => {
    const files = [record('same', null), record('same', 'remote')]
    const normalized = preservePersistedEditorFileRecords(files, WS, (seed) => seed)
    expect(new Set(normalized.map((file) => editorFileRecordKey(file, WS))).size).toBe(2)
    expect(normalized.map((file) => file.dirtyDraftContent)).toEqual(['same-draft', 'same-draft'])
    expect(
      preservePersistedEditorFileRecords(normalized, WS, () => {
        throw new Error('should not mint on restart')
      })
    ).toEqual(normalized)
    expect(files[1]?.id).toBe('same')
  })

  it('deduplicates equivalent legacy records and prefers the dirty twin', () => {
    const dirty = { ...record('file', null), id: undefined }
    const clean = { ...dirty, dirtyDraftContent: undefined, lastKnownDiskSignature: undefined }
    expect(
      preservePersistedEditorFileRecords([clean, dirty], WS, () => {
        throw new Error('equivalent records need no mint')
      })
    ).toEqual([dirty])
    expect(
      preservePersistedEditorFileRecords([dirty, clean], WS, () => {
        throw new Error('equivalent records need no mint')
      })
    ).toEqual([dirty])
  })
})
