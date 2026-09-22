/** Bounded so a host that runs for weeks cannot grow this without limit. */
export const MAX_RETIRED_TERMINAL_PANE_RECORDS = 512

/**
 * The host's own pane-keyed record that it retired a terminal surface.
 *
 * Separate from the retirement proofs on a session-tab snapshot: those are a client-facing
 * attestation and are keyed by a terminal handle, so a pane the host user created in the desktop
 * renderer and never addressed by handle produces none. This ledger is keyed by the pane alone,
 * which is what a create replaying that pane's ids has to be refused against.
 *
 * In-memory for the process lifetime. A host that restarted no longer holds the closed tab in any
 * form, so there is nothing for a persisted record to protect that the client's own resync does not.
 */
export class RetiredTerminalPaneLedger {
  private readonly retiredAtByKey = new Map<string, number>()

  private static key(worktreeId: string, tabId: string, leafId: string): string {
    return `${worktreeId}\0${tabId}\0${leafId}`
  }

  record(worktreeId: string, tabId: string, leafId: string, retiredAt: number): void {
    const key = RetiredTerminalPaneLedger.key(worktreeId, tabId, leafId)
    this.retiredAtByKey.delete(key)
    this.retiredAtByKey.set(key, retiredAt)
    while (this.retiredAtByKey.size > MAX_RETIRED_TERMINAL_PANE_RECORDS) {
      const oldest = this.retiredAtByKey.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.retiredAtByKey.delete(oldest)
    }
  }

  has(worktreeId: string, tabId: string, leafId: string): boolean {
    return this.retiredAtByKey.has(RetiredTerminalPaneLedger.key(worktreeId, tabId, leafId))
  }

  get size(): number {
    return this.retiredAtByKey.size
  }
}
