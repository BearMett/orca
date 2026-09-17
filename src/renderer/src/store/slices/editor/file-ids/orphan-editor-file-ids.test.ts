import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../../../shared/tab-types'
import { collectHydratedOrphanEditorFileIds } from './orphan-editor-file-ids'

const WORKTREE_ID = 'repo-1::/workspace'
const TABBED_FILE_ID = '/workspace/tabbed.ts'
const ORPHAN_FILE_ID = '/workspace/orphan.ts'

function editorTab(entityId: string): Tab {
  return {
    id: `tab:${entityId}`,
    entityId,
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function collectOrphans(
  orphan: { isDirty?: boolean },
  editorDrafts: Record<string, string>
): Set<string> {
  return collectHydratedOrphanEditorFileIds(
    [
      { id: TABBED_FILE_ID, worktreeId: WORKTREE_ID, isDirty: false },
      { id: ORPHAN_FILE_ID, worktreeId: WORKTREE_ID, isDirty: orphan.isDirty ?? false }
    ],
    { [WORKTREE_ID]: [editorTab(TABBED_FILE_ID)] },
    { [WORKTREE_ID]: TABBED_FILE_ID },
    editorDrafts
  )
}

describe('collectHydratedOrphanEditorFileIds', () => {
  it('reports a clean document no editor tab references', () => {
    expect([...collectOrphans({}, {})]).toEqual([ORPHAN_FILE_ID])
  })

  it('keeps an orphan whose unsaved draft has not flushed into isDirty yet', () => {
    expect([...collectOrphans({}, { [ORPHAN_FILE_ID]: 'typed but not flushed' })]).toEqual([])
  })

  it('keeps an orphan that already flushed its dirty flag', () => {
    expect([...collectOrphans({ isDirty: true }, {})]).toEqual([])
  })
})
