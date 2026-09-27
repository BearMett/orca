import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import { buildPersistedUnifiedTabSessionData } from './workspace-session-unified-tabs'

const WORKTREE_ID = 'wt-1'

function editorTab(): Tab {
  return {
    id: 'tab-1',
    entityId: '/x/README.md',
    groupId: 'group-1',
    worktreeId: WORKTREE_ID,
    contentType: 'editor',
    label: 'README.md',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('buildPersistedUnifiedTabSessionData', () => {
  it('writes one record for repeated tab ids', () => {
    const persisted = buildPersistedUnifiedTabSessionData({
      unifiedTabsByWorktree: { [WORKTREE_ID]: [editorTab(), editorTab()] },
      groupsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'group-1', worktreeId: WORKTREE_ID, activeTabId: 'tab-1', tabOrder: ['tab-1'] }
        ]
      },
      layoutByWorktree: {},
      activeGroupIdByWorktree: {}
    })

    expect(persisted.unifiedTabs?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(persisted.tabGroups?.[WORKTREE_ID]?.[0]?.tabOrder).toEqual(['tab-1'])
  })
})
