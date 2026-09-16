import type { ClientOptions } from 'ws'

/**
 * Connect-phase bound for the Node-side remote-runtime WebSocket transports.
 *
 * Why: a host that is powered off or firewalled black-holes the TCP SYN, so the
 * socket neither opens nor errors. Without this the only bound is the caller's
 * whole-request timeout (60s in the CLI), which reads to the user as a frozen
 * terminal.
 *
 * `ws` maps `handshakeTimeout` onto the `http.request` `timeout`, which Node
 * implements as a socket *inactivity* timer: armed before DNS/connect and reset
 * by connect completion and by every response chunk. So this is "12s with no
 * bytes at all", not a 12s wall-clock budget — a slow-but-answering host is not
 * cut off, while a silent one fails promptly.
 *
 * The value matches `CONNECT_TIMEOUT_MS` in
 * `src/renderer/src/web/web-runtime-connection-transport.ts`, which already
 * bounded the browser transport (a wall-clock budget there).
 */
export const REMOTE_RUNTIME_CONNECT_TIMEOUT_MS = 12_000

/** The `ws` message for an elapsed `handshakeTimeout`; matched, never thrown by us. */
export const WS_HANDSHAKE_TIMEOUT_MESSAGE = 'Opening handshake has timed out'

/**
 * Every connect failure starts with this phrase. It is load-bearing, not copy:
 * `RECOVERABLE_MESSAGE_FRAGMENTS` and `REMOTE_RUNTIME_UNREACHABLE_RE` both key
 * on it, and the subscribe IPC boundary drops the error `code`, so on that path
 * the phrase is the only thing keeping the terminal pane retrying instead of
 * dead-ending. Reword it and both gates go silent.
 */
export const REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE = 'Could not connect to the remote Orca runtime'

export function remoteRuntimeConnectOptions<TOptions extends ClientOptions>(
  options?: TOptions,
  connectTimeoutMs: number = REMOTE_RUNTIME_CONNECT_TIMEOUT_MS
): TOptions & { handshakeTimeout: number } {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the empty default stands in for an absent TOptions; every property it could carry is optional, and the spread below is the only use.
    ...(options ?? ({} as TOptions)),
    handshakeTimeout: connectTimeoutMs
  }
}

export function isRemoteRuntimeConnectTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === WS_HANDSHAKE_TIMEOUT_MESSAGE
}

/**
 * Why: per `docs/reference/ssh-execution-boundary.md`, loss of contact is never
 * evidence that remote work stopped. This message says the host did not answer
 * and stops there — it must not imply the host's terminals are gone.
 */
export function remoteRuntimeConnectFailureMessage(
  error: unknown,
  endpoint: string,
  connectTimeoutMs: number = REMOTE_RUNTIME_CONNECT_TIMEOUT_MS
): string {
  if (!isRemoteRuntimeConnectTimeout(error)) {
    return `${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE}.`
  }
  return (
    `${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE} at ${endpoint}: the host did not answer ` +
    `within ${connectTimeoutMs / 1000}s, so anything running on it is unverifiable.`
  )
}
