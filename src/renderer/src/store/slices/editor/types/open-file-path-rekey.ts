/** One tab's migration in an Orca-owned move; precomputed by the move coordinator. */
export type OpenFilePathRekey = {
  oldFileId: string
  newFileId: string
  oldFilePath: string
  newFilePath: string
  newRelativePath: string
  newLanguage?: string
  newMarkdownPreviewSourceFileId?: string
  /** Explicit rename of an untitled file consumes its untitled status. */
  consumeUntitled?: boolean
}

/** `unresolved`: an open copy under the path has no placeable host, so the move cannot say whether it moved. */
export type RekeyOpenFilesResult =
  | { ok: true }
  | { ok: false; reason: 'collision' | 'stale' | 'unresolved' }
