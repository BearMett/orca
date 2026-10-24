// Tail of pr-code-change-scope.mjs CROSS_VERSION_WIRE_PREFIXES, split out for its line budget.
export const CROSS_VERSION_STORAGE_AND_MIRROR_PREFIXES = [
  // An older app opening a newer orchestration database (orchestration-delivery-downgrade).
  'src/main/runtime/orchestration/db.ts',
  'src/main/runtime/orchestration/db/',
  'src/main/runtime/orchestration/orchestration-schema-version-skew',
  // Editor tabs a paired host publishes and an older peer mirrors (cross-version-session-tabs-editor-mirror).
  'src/renderer/src/runtime/sync-runtime-graph/mobile-session-',
  'src/renderer/src/runtime/web-session-tabs-sync/',
  'src/shared/workspace-session-editor-schema',
  'src/shared/workspace-session-salvage'
]
