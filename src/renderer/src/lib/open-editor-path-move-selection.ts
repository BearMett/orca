import { getEditorFileBackingHost } from '@/components/editor/editor-model-owner'
import type { OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store/types'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseExecutionHostId } from '../../../shared/execution-host'

/** The host whose disk a move renamed, taken from the operation's own route. */
export type EditorPathMoveOwner = {
  runtimeEnvironmentId: string | null
  sshTargetId: string | null
}

/**
 * Open files backed by the path the move renamed. The same absolute path can be
 * open for another host (local vs runtime, another SSH target) even inside one
 * workspace; those are distinct files the rename never touched.
 */
export function selectOpenFilesForPathMove(
  state: Pick<AppState, 'openFiles'> & Parameters<typeof getEditorFileBackingHost>[1],
  fromPath: string,
  worktreeId: string | undefined,
  owner: EditorPathMoveOwner
): OpenFile[] {
  return state.openFiles.filter((file) => {
    // Flavor-aware containment folds case and separators (Windows/UNC/WSL).
    if (!isPathInsideOrEqual(fromPath, file.filePath)) {
      return false
    }
    const host = getEditorFileBackingHost(file, state)
    if (!host.executionHostId) {
      // Why: floating files live on this machine; any other ownerless file can only belong to
      // the workspace that moved it.
      return file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID
        ? owner.runtimeEnvironmentId === null && owner.sshTargetId === null
        : file.worktreeId === worktreeId
    }
    const parsed = parseExecutionHostId(host.executionHostId)
    return (
      host.runtimeEnvironmentId === owner.runtimeEnvironmentId &&
      (parsed?.kind === 'ssh' ? parsed.targetId : null) === owner.sshTargetId
    )
  })
}
