import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { PersistedOpenFile, WorkspaceSessionState } from '../workspace-session-state-types'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { saveWorkspaceLayout } from './workspace-layout-save'
import {
  DESKTOP_VIEW_ID,
  deviceViewId,
  setViewRecord,
  viewRecordOf
} from './workspace-layout-views'
import { emptySession, GIT_KEY } from './workspace-layout-session.test-fixture'

const FILE_PATH = '/Users/dev/orca/src/app.ts'
const PHONE = deviceViewId('phone-1')

const LOCAL_DIRTY: Partial<PersistedOpenFile> = {
  runtimeEnvironmentId: null,
  dirtyDraftContent: 'local draft',
  lastKnownDiskSignature: 'sig-local'
}
const REMOTE_DIRTY: Partial<PersistedOpenFile> = {
  runtimeEnvironmentId: 'env-remote',
  dirtyDraftContent: 'remote draft',
  lastKnownDiskSignature: 'sig-remote'
}

function fileRecord(owner: Partial<PersistedOpenFile>): PersistedOpenFile {
  return {
    filePath: FILE_PATH,
    relativePath: 'src/app.ts',
    worktreeId: GIT_KEY,
    language: 'typescript',
    ...owner
  }
}

function sessionWithFiles(owners: Partial<PersistedOpenFile>[]): WorkspaceSessionState {
  return { ...emptySession(), openFilesByWorktree: { [GIT_KEY]: owners.map(fileRecord) } }
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

function roundTripFiles(session: WorkspaceSessionState) {
  const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, session, nameBasedLoadContext())
  return saveWorkspaceLayout(loaded).openFilesByWorktree?.[GIT_KEY]
}

describe('shared Loader/Serializer: editor drafts of same-path files with different owners', () => {
  it('keeps each owner its own draft when the local record is stored first', () => {
    const stored = sessionWithFiles([LOCAL_DIRTY, REMOTE_DIRTY])

    expect(draftsByOwner(roundTripFiles(stored))).toEqual(
      draftsByOwner(stored.openFilesByWorktree?.[GIT_KEY])
    )
  })

  it('keeps each owner its own draft when the runtime record is stored first', () => {
    const stored = sessionWithFiles([REMOTE_DIRTY, LOCAL_DIRTY])

    expect(draftsByOwner(roundTripFiles(stored))).toEqual(
      draftsByOwner(stored.openFilesByWorktree?.[GIT_KEY])
    )
  })

  it('leaves a clean twin clean when only the other owner has a draft', () => {
    const stored = sessionWithFiles([{ runtimeEnvironmentId: null }, REMOTE_DIRTY])

    expect(draftsByOwner(roundTripFiles(stored))).toEqual(
      draftsByOwner(stored.openFilesByWorktree?.[GIT_KEY])
    )
  })

  it('reports draft changes separately from the legacy record ID upgrade', () => {
    const stored = sessionWithFiles([LOCAL_DIRTY, REMOTE_DIRTY])
    const loaded = loadWorkspaceLayout(LOCAL_EXECUTION_HOST_ID, stored, nameBasedLoadContext())
    const saved = saveWorkspaceLayout(loaded).openFilesByWorktree?.[GIT_KEY]

    const draftsRewritten =
      JSON.stringify(draftsByOwner(saved)) !==
      JSON.stringify(draftsByOwner(stored.openFilesByWorktree?.[GIT_KEY]))

    // The shadow self-check only sees what this diff reports.
    expect(
      loaded.changes.some(
        (change) =>
          change.table === 'file' &&
          (change.field === 'dirtyDraftContent' || change.field === 'lastKnownDiskSignature')
      )
    ).toBe(draftsRewritten)
    expect(
      loaded.changes.filter((change) => change.table === 'file' && change.field === 'id')
    ).toHaveLength(2)
  })

  it('keeps both file records', () => {
    const stored = sessionWithFiles([LOCAL_DIRTY, REMOTE_DIRTY])

    expect(roundTripFiles(stored)?.map((file) => file.runtimeEnvironmentId ?? 'local')).toEqual([
      'local',
      'env-remote'
    ])
  })
})

describe('shared per-view store: editor drafts (#27535)', () => {
  it('keeps loaded drafts on the desktop view and shows none to a second view', () => {
    const loaded = loadWorkspaceLayout(
      LOCAL_EXECUTION_HOST_ID,
      sessionWithFiles([LOCAL_DIRTY]),
      nameBasedLoadContext()
    )
    const desktopOnly = setViewRecord({}, DESKTOP_VIEW_ID, loaded.desktopView)
    const both = setViewRecord(desktopOnly, PHONE, loaded.desktopView)

    expect(viewRecordOf(desktopOnly, DESKTOP_VIEW_ID).editorDrafts).toEqual({
      [GIT_KEY]: {
        [FILE_PATH]: { dirtyDraftContent: 'local draft', lastKnownDiskSignature: 'sig-local' }
      }
    })
    expect(viewRecordOf(desktopOnly, PHONE).editorDrafts).toEqual({})
    expect(viewRecordOf(both, PHONE).editorDrafts).toEqual({})
    expect(viewRecordOf(both, DESKTOP_VIEW_ID).editorDrafts).toEqual(
      loaded.desktopView.editorDrafts
    )
  })
})
