import type { OpenFile } from '@/store/slices/editor'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRouteState
} from '@/lib/worktree-operation-route'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

/** The host whose disk backs an open file; `executionHostId: null` means unresolved. */
export type EditorFileBackingHost = {
  runtimeEnvironmentId: string | null
  executionHostId: ExecutionHostId | null
}

export function getEditorFileBackingHost(
  file: Pick<
    OpenFile,
    'worktreeId' | 'runtimeEnvironmentId' | 'externalSshTargetId' | 'operationProvenance'
  >,
  state: WorktreeOperationRouteState
): EditorFileBackingHost {
  const captured = file.operationProvenance?.generation.route
  if (captured) {
    return {
      runtimeEnvironmentId: captured.runtimeEnvironmentId,
      executionHostId: captured.executionHostId
    }
  }
  const route = resolveWorktreeOperationRoute(
    state.activeWorktreeId === file.worktreeId ? { ...state, activeWorktreeId: null } : state,
    file.worktreeId
  )
  const environmentId =
    file.runtimeEnvironmentId !== undefined
      ? file.runtimeEnvironmentId?.trim() || null
      : (route?.runtimeEnvironmentId ?? null)
  const hostId = file.externalSshTargetId
    ? toSshExecutionHostId(file.externalSshTargetId)
    : route &&
        (file.runtimeEnvironmentId === undefined ||
          (file.runtimeEnvironmentId || null) === route.runtimeEnvironmentId)
      ? route.executionHostId
      : environmentId
        ? toRuntimeExecutionHostId(environmentId)
        : null
  return { runtimeEnvironmentId: environmentId, executionHostId: hostId }
}

export function getEditorModelOwnerKey(file: OpenFile, state: WorktreeOperationRouteState): string {
  const { runtimeEnvironmentId: environmentId, executionHostId: hostId } = getEditorFileBackingHost(
    file,
    state
  )
  if (hostId === 'local' && !environmentId) {
    return ''
  }
  // Unresolved owners must not borrow another host's retained text.
  return JSON.stringify(
    hostId ? [environmentId, hostId] : [environmentId, 'unresolved', file.worktreeId, file.id]
  )
}
