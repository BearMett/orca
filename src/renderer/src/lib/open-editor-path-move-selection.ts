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
  owner: EditorPathMoveOwner
): OpenFile[] {
  return state.openFiles.filter((file) => {
    // Flavor-aware containment folds case and separators (Windows/UNC/WSL).
    if (!isPathInsideOrEqual(fromPath, file.filePath)) {
      return false
    }
    // Why: the Active Server setting names no file's host; blanking it keeps the route focus-free.
    const host = getEditorFileBackingHost(file, { ...state, settings: null })
    if (!host.executionHostId) {
      // Why: `runtimeEnvironmentId: null` means "no runtime transport", which an SSH workspace's
      // files share with local ones; a record no row or provenance places could sit on a disk the
      // rename never touched, so it stays put. Floating files always live on this machine.
      return (
        file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID &&
        owner.runtimeEnvironmentId === null &&
        owner.sshTargetId === null
      )
    }
    const parsed = parseExecutionHostId(host.executionHostId)
    return (
      host.runtimeEnvironmentId === owner.runtimeEnvironmentId &&
      (parsed?.kind === 'ssh' ? parsed.targetId : null) === owner.sshTargetId
    )
  })
}
