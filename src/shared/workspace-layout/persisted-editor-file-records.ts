import type { PersistedOpenFile } from '../workspace-session-state-types'
import { editorFileRecordKey } from './editor-file-record-identity'

export function preservePersistedEditorFileRecords(
  files: readonly PersistedOpenFile[],
  worktreeId: string,
  mintId: (seed: string) => string
): PersistedOpenFile[] {
  const records: PersistedOpenFile[] = []
  const recordsByOwner = new Map<string, number[]>()
  for (const file of files) {
    const owner = JSON.stringify([
      file.filePath,
      file.runtimeEnvironmentId?.trim() || null,
      file.externalSshTargetId ?? null,
      file.readOnly === true,
      file.readOnly === true && file.liveTail === true
    ])
    const indices = recordsByOwner.get(owner) ?? []
    const draft = file.readOnly ? undefined : file.dirtyDraftContent
    const equivalent = indices.find((index) => {
      const existing = records[index]
      if (file.id && existing.id && file.id !== existing.id) {
        return false
      }
      return (
        draft === undefined ||
        existing.dirtyDraftContent === undefined ||
        (existing.dirtyDraftContent === draft &&
          existing.lastKnownDiskSignature === file.lastKnownDiskSignature)
      )
    })
    if (equivalent !== undefined) {
      if (draft !== undefined && records[equivalent].dirtyDraftContent === undefined) {
        records[equivalent] = {
          ...file,
          ...(records[equivalent].id ? { id: records[equivalent].id } : {})
        }
      }
      continue
    }
    const recovery = indices.length > 0
    if (recovery) {
      for (const index of indices) {
        records[index] = {
          ...records[index],
          id: editorFileRecordKey(records[index], worktreeId),
          recoveredDraft: true
        }
      }
    }
    if (recovery) {
      const id =
        file.id && !records.some((record) => record.id === file.id)
          ? file.id
          : mintId(`recovered-editor:${worktreeId}:${owner}:${indices.length}`)
      records.push({ ...file, id, recoveredDraft: true })
    } else {
      records.push(file)
    }
    recordsByOwner.set(owner, [...indices, records.length - 1])
  }
  const ids = new Set<string>()
  return records.map((file, index) => {
    const key = editorFileRecordKey(file, worktreeId)
    if (ids.has(key)) {
      const id = mintId(`recovered-editor-id:${worktreeId}:${index}:${key}`)
      ids.add(id)
      return { ...file, id, recoveredDraft: true }
    }
    ids.add(key)
    return file
  })
}
