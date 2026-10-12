import { ownedEditorFileId } from '../workspace-session-pane-ownership'
import type { PersistedOpenFile } from '../workspace-session-state-types'

type FileIdentity = Pick<
  PersistedOpenFile,
  'id' | 'filePath' | 'runtimeEnvironmentId' | 'externalSshTargetId'
>

export function editorFileRecordKey(file: FileIdentity, worktreeId: string): string {
  if (file.id) {
    return file.id
  }
  if (file.externalSshTargetId) {
    return JSON.stringify([
      worktreeId,
      file.filePath,
      file.runtimeEnvironmentId ?? null,
      file.externalSshTargetId
    ])
  }
  return file.runtimeEnvironmentId?.trim()
    ? ownedEditorFileId(file.filePath, worktreeId, file.runtimeEnvironmentId)
    : file.filePath
}

export function resolveEditorFileRecord<T extends FileIdentity>(
  files: readonly T[] | undefined,
  entityId: string,
  worktreeId: string
): T | undefined {
  const exact = files?.filter((file) => editorFileRecordKey(file, worktreeId) === entityId) ?? []
  if (exact.length === 1) {
    return exact[0]
  }
  if (exact.length > 1) {
    return undefined
  }
  const legacy = files?.filter((file) => file.filePath === entityId) ?? []
  return legacy.length === 1 ? legacy[0] : undefined
}
