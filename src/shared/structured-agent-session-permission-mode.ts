export const STRUCTURED_AGENT_SESSION_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto'
] as const

export type StructuredAgentSessionPermissionMode =
  (typeof STRUCTURED_AGENT_SESSION_PERMISSION_MODES)[number]

export function readStructuredAgentSessionPermissionMode(
  value: unknown
): StructuredAgentSessionPermissionMode | null {
  return STRUCTURED_AGENT_SESSION_PERMISSION_MODES.find((mode) => mode === value) ?? null
}
