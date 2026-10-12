// Editor tabs follow a file renamed on disk. An editor tab and its file record are keyed by the
// file's path, so a rename rekeys both; two open files are never merged into one tab.

import { applied, refuse, type Applied } from './workspace-layout-command-steps'
import type { LayoutEditorFile, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { resolveEditorFileRecord } from './editor-file-record-identity'

/** One renamed file; the rename boundary expands a renamed folder into its open files. */
export type EditorFileRename = {
  fromFilePath: string
  toFilePath: string
  toRelativePath: string
  /** Set when the new name changes the file's language. */
  toLanguage?: string
}

/**
 * Refused as a whole when two files would land on one path, or a file would land on an open one
 * that is not itself moving away. Files that are not open are ignored.
 */
export function renameEditorFiles(
  model: WorkspaceLayoutModel,
  workspaceKey: string,
  renames: readonly EditorFileRename[]
): Applied {
  const workspace = model.workspaces[workspaceKey]
  if (!workspace) {
    return applied(model)
  }
  for (const rename of renames) {
    const owners = new Set(
      (workspace.editorFiles ?? [])
        .filter((file) => file.filePath === rename.fromFilePath)
        .map((file) =>
          JSON.stringify([
            file.runtimeEnvironmentId?.trim() || null,
            file.externalSshTargetId ?? null
          ])
        )
    )
    if (owners.size > 1) {
      return refuse('invalid_params')
    }
  }
  const openPaths = new Set(
    workspace.tabs.flatMap((tab) => {
      const file =
        tab.kind === 'editor'
          ? resolveEditorFileRecord(workspace.editorFiles, tab.entityId, workspaceKey)
          : undefined
      return file ? [file.filePath] : []
    })
  )
  const moves = new Map(
    renames
      .filter((rename) => openPaths.has(rename.fromFilePath))
      .map((rename) => [rename.fromFilePath, rename])
  )
  if (moves.size === 0) {
    return applied(model)
  }
  const targets = new Set<string>()
  for (const { toFilePath } of moves.values()) {
    if (targets.has(toFilePath) || (openPaths.has(toFilePath) && !moves.has(toFilePath))) {
      return refuse('invalid_params')
    }
    targets.add(toFilePath)
  }
  const renamedPath = (path: string) => moves.get(path)?.toFilePath ?? path
  // A tab-bar id that is the file's path follows it too.
  const renamedTabIds = new Map<string, string>()
  const tabs = workspace.tabs.map((tab) => {
    const file =
      tab.kind === 'editor'
        ? resolveEditorFileRecord(workspace.editorFiles, tab.entityId, workspaceKey)
        : undefined
    if (!file || !moves.has(file.filePath) || file.id || tab.entityId !== file.filePath) {
      return tab
    }
    const id = tab.id === tab.entityId ? renamedPath(tab.id) : tab.id
    renamedTabIds.set(tab.id, id)
    return { ...tab, id, entityId: renamedPath(tab.entityId) }
  })
  const groups = workspace.groups.map((group) => ({
    ...group,
    tabOrder: group.tabOrder.map((id) => renamedTabIds.get(id) ?? id)
  }))
  const opaqueFileIds = new Map(
    workspace.tabs.flatMap((tab) => {
      const file =
        tab.kind === 'editor'
          ? resolveEditorFileRecord(workspace.editorFiles, tab.entityId, workspaceKey)
          : undefined
      return file && !file.id && tab.entityId !== file.filePath
        ? [[file, tab.entityId] as const]
        : []
    })
  )
  const editorFiles = workspace.editorFiles?.map((file): LayoutEditorFile => {
    const rename = moves.get(file.filePath)
    return rename
      ? {
          ...file,
          ...(opaqueFileIds.has(file) ? { id: opaqueFileIds.get(file) } : {}),
          filePath: rename.toFilePath,
          relativePath: rename.toRelativePath,
          ...(rename.toLanguage !== undefined ? { language: rename.toLanguage } : {})
        }
      : file
  })
  return applied(
    withWorkspace(model, workspaceKey, {
      ...workspace,
      tabs,
      groups,
      ...(editorFiles ? { editorFiles } : {})
    }),
    { renamedTabIds: Object.fromEntries([...renamedTabIds].filter(([from, to]) => from !== to)) }
  )
}
