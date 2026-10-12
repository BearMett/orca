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

/** Files the move retargets, and files under the path whose host nothing can name. */
export type OpenFilesForPathMove = {
  selected: OpenFile[]
  unresolved: OpenFile[]
}

/**
 * Open files backed by the path the move renamed. The same absolute path can be
 * open for another host (local vs runtime, another SSH target) even inside one
 * workspace; those are distinct files the rename never touched. A file whose host
 * neither its provenance nor its workspace rows can name is reported as
 * `unresolved`: it may be the renaming host's own file, so a move that skips it
 * would strand its tab at the old path, and the caller must refuse before the disk changes.
 */
export function partitionOpenFilesForPathMove(
  state: Pick<AppState, 'openFiles'> & Parameters<typeof getEditorFileBackingHost>[1],
  fromPath: string,
  owner: EditorPathMoveOwner
): OpenFilesForPathMove {
  const selected: OpenFile[] = []
  const unresolved: OpenFile[] = []
  const isLocalMove = owner.runtimeEnvironmentId === null && owner.sshTargetId === null
  for (const file of state.openFiles) {
    // Flavor-aware containment folds case and separators (Windows/UNC/WSL).
    if (!isPathInsideOrEqual(fromPath, file.filePath)) {
      continue
    }
    // Why: the Active Server setting names no file's host; blanking it keeps the route focus-free.
    const host = getEditorFileBackingHost(file, { ...state, settings: null })
    if (!host.executionHostId) {
      // Why: `runtimeEnvironmentId: null` means "no runtime transport", which an SSH workspace's
      // files share with local ones, so it is not local evidence. Floating files always live on
      // this machine.
      if (file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
        if (isLocalMove) {
          selected.push(file)
        }
      } else {
        unresolved.push(file)
      }
      continue
    }
    const parsed = parseExecutionHostId(host.executionHostId)
    if (
      host.runtimeEnvironmentId === owner.runtimeEnvironmentId &&
      (parsed?.kind === 'ssh' ? parsed.targetId : null) === owner.sshTargetId
    ) {
      selected.push(file)
    }
  }
  return { selected, unresolved }
}

export function selectOpenFilesForPathMove(
  state: Pick<AppState, 'openFiles'> & Parameters<typeof getEditorFileBackingHost>[1],
  fromPath: string,
  owner: EditorPathMoveOwner
): OpenFile[] {
  return partitionOpenFilesForPathMove(state, fromPath, owner).selected
}
