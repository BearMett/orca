import type { PersistedOpenFile } from '../../../shared/workspace-session-state-types'
import type { OpenFile } from '../store/slices/editor'
import { runtimeOwnerKey } from '../store/slices/editor/file-ids/editor-file-ids'

/**
 * Identity of a persisted editor record. Persisted records carry no id, so two live OpenFiles
 * sharing this key serialize to indistinguishable rows that restore as one document — the write
 * has to merge them instead of stacking another duplicate on every save.
 */
export function persistedOpenFileOwnerKey(
  file: Pick<
    OpenFile,
    | 'worktreeId'
    | 'runtimeEnvironmentId'
    | 'externalSshTargetId'
    | 'filePath'
    | 'readOnly'
    | 'liveTail'
  >
): string {
  return JSON.stringify([
    file.worktreeId,
    runtimeOwnerKey(file.runtimeEnvironmentId),
    file.externalSshTargetId?.trim() || null,
    file.filePath,
    // Why: a read-only log tab and a writable tab on one path are different documents — merging
    // them would restore the log writable, carrying a hot-exit draft it must never have.
    file.readOnly === true,
    file.liveTail === true
  ])
}

export type PersistedEditorFileRecords = {
  openFilesByWorktree: Record<string, PersistedOpenFile[]>
  /** Ids of the live OpenFiles that own a persisted record, per worktree. */
  editFileIdsByWorktree: Record<string, Set<string>>
  /** Merged-away OpenFile id → the id whose record replaced it. */
  survivingFileIdByMergedId: Map<string, string>
}

function toPersistedOpenFile(
  file: OpenFile,
  editorDrafts: Record<string, string>
): PersistedOpenFile {
  // Why: never persist a dirty draft for a read-only tab — restoring one would reintroduce writable/hot-exit state for an agent transcript.
  const dirtyDraftContent =
    file.isDirty && file.readOnly !== true ? editorDrafts[file.id] : undefined
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    language: file.language,
    isPreview: file.isPreview || undefined,
    runtimeEnvironmentId: file.runtimeEnvironmentId,
    externalSshTargetId: file.externalSshTargetId,
    // Why: persist readOnly only when true; absence is the writable default on restore.
    ...(file.readOnly === true ? { readOnly: true } : {}),
    ...(file.readOnly === true && file.liveTail === true ? { liveTail: true } : {}),
    ...(dirtyDraftContent !== undefined ? { dirtyDraftContent } : {}),
    // Why: baseline travels with the draft so restore can detect a changed-on-disk conflict before autosave clobbers an offline agent write.
    ...(dirtyDraftContent !== undefined && file.lastKnownDiskSignature
      ? { lastKnownDiskSignature: file.lastKnownDiskSignature }
      : {})
  }
}

/** Two unsaved buffers that disagree: merging would silently destroy one of them. */
function hasDivergentDraft(left: PersistedOpenFile, right: PersistedOpenFile): boolean {
  return (
    left.dirtyDraftContent !== undefined &&
    right.dirtyDraftContent !== undefined &&
    left.dirtyDraftContent !== right.dirtyDraftContent
  )
}

function winsOverKeptRecord(
  candidate: { record: PersistedOpenFile; fileId: string },
  kept: { record: PersistedOpenFile; fileId: string },
  activeFileId: string | null | undefined
): boolean {
  if (kept.record.dirtyDraftContent !== undefined) {
    return false
  }
  if (candidate.record.dirtyDraftContent !== undefined) {
    return true
  }
  // Why before the active-file rule: a preview record restores a tab the next single click replaces.
  if (kept.record.isPreview !== candidate.record.isPreview) {
    return kept.record.isPreview === true
  }
  return candidate.fileId === activeFileId && kept.fileId !== activeFileId
}

function resolveSurvivingFileId(merged: Map<string, string>, fileId: string): string {
  let current = fileId
  const seen = new Set<string>([fileId])
  let next = merged.get(current)
  while (next !== undefined && !seen.has(next)) {
    seen.add(next)
    current = next
    next = merged.get(current)
  }
  return current
}

/** Serialize the edit-mode documents, collapsing records that cannot be told apart on restore. */
export function buildPersistedEditorFileRecords(
  openFiles: readonly OpenFile[],
  editorDrafts: Record<string, string>,
  activeFileIdByWorktree: Record<string, string | null>
): PersistedEditorFileRecords {
  const openFilesByWorktree: Record<string, PersistedOpenFile[]> = {}
  const editFileIdsByWorktree: Record<string, Set<string>> = {}
  const survivingFileIdByMergedId = new Map<string, string>()
  const keptByOwnerKey = new Map<
    string,
    { record: PersistedOpenFile; fileId: string; position: number }
  >()

  for (const file of openFiles) {
    if (file.mode !== 'edit') {
      continue
    }
    const records =
      openFilesByWorktree[file.worktreeId] ?? (openFilesByWorktree[file.worktreeId] = [])
    const fileIds =
      editFileIdsByWorktree[file.worktreeId] ?? (editFileIdsByWorktree[file.worktreeId] = new Set())
    const record = toPersistedOpenFile(file, editorDrafts)
    const ownerKey = persistedOpenFileOwnerKey(file)
    const kept = keptByOwnerKey.get(ownerKey)
    if (!kept || hasDivergentDraft(kept.record, record)) {
      records.push(record)
      fileIds.add(file.id)
      if (!kept) {
        keptByOwnerKey.set(ownerKey, { record, fileId: file.id, position: records.length - 1 })
      }
      continue
    }
    if (
      !winsOverKeptRecord(
        { record, fileId: file.id },
        kept,
        activeFileIdByWorktree[file.worktreeId]
      )
    ) {
      survivingFileIdByMergedId.set(file.id, kept.fileId)
      continue
    }
    records[kept.position] = record
    fileIds.delete(kept.fileId)
    fileIds.add(file.id)
    survivingFileIdByMergedId.set(kept.fileId, file.id)
    keptByOwnerKey.set(ownerKey, { record, fileId: file.id, position: kept.position })
  }

  for (const mergedId of survivingFileIdByMergedId.keys()) {
    survivingFileIdByMergedId.set(
      mergedId,
      resolveSurvivingFileId(survivingFileIdByMergedId, mergedId)
    )
  }
  return { openFilesByWorktree, editFileIdsByWorktree, survivingFileIdByMergedId }
}
