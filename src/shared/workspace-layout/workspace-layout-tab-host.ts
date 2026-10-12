// The one execution host every tab-bar entry names (as the window stamps new tabs), derived from
// what owns the tab.

import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { TabContentType } from '../tab-types'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import { resolveEditorFileRecord } from './editor-file-record-identity'

type FileOwner = Pick<
  PersistedOpenFile,
  'id' | 'filePath' | 'externalSshTargetId' | 'runtimeEnvironmentId'
>

/** An editor tab follows its file's owner, as the window stamps it; every other tab its partition. */
export function tabExecutionHostId(
  tab: { kind: TabContentType; entityId: string },
  files: readonly FileOwner[] | undefined,
  hostId: ExecutionHostId,
  worktreeId: string
): ExecutionHostId {
  const file =
    tab.kind === 'editor' ? resolveEditorFileRecord(files, tab.entityId, worktreeId) : undefined
  if (file?.externalSshTargetId) {
    return toSshExecutionHostId(file.externalSshTargetId)
  }
  if (file?.runtimeEnvironmentId) {
    return toRuntimeExecutionHostId(file.runtimeEnvironmentId)
  }
  return hostId
}
