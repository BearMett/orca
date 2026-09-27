import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeState as makePublicationState } from '../sync-runtime-graph-test-harness'
import { applyWebSessionTabsSnapshot } from '../web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../web-session-tabs-sync-test-harness'
import { buildMobileSessionTabSnapshots } from './mobile-session-snapshots'

vi.mock('../../store', () => ({ useAppStore: { setState: vi.fn() } }))

describe('mirrored editor tab republication', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('republishes a file mirrored from a host snapshot', () => {
    const state = makeState()
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([
        {
          type: 'file',
          id: 'host-file-tab',
          title: 'app.ts',
          filePath: '/repo/app.ts',
          relativePath: 'app.ts',
          language: 'typescript',
          mode: 'edit',
          isDirty: false,
          isActive: true
        }
      ]),
      ENV,
      NOW
    )
    const clientState = makePublicationState({ ...state, ...patch })

    expect(clientState.openFiles).toMatchObject([
      { worktreeId: WT, runtimeEnvironmentId: ENV, mirroredFromRuntimeSession: true }
    ])
    expect(clientState.unifiedTabsByWorktree[WT]).toMatchObject([
      { id: 'host-file-tab', contentType: 'editor' }
    ])
    const snapshot = buildMobileSessionTabSnapshots(clientState, false).find(
      (candidate) => candidate.worktree === WT
    )
    expect(snapshot?.tabs).toMatchObject([
      { type: 'file', id: 'host-file-tab', filePath: '/repo/app.ts' }
    ])
  })
})
