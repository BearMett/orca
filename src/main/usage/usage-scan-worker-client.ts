import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsagePersistedFile,
  ClaudeUsageSession
} from '../claude-usage/types'
import type {
  CodexUsageDailyAggregate,
  CodexUsagePersistedFile,
  CodexUsageSession
} from '../codex-usage/types'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from '../opencode-usage/types'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import type {
  UsageScanWorkerProviderId,
  UsageScanWorkerRequest,
  UsageScanWorkerRequestBody,
  UsageScanWorkerResponse,
  UsageScanWorkerValue
} from './usage-scan-worker-protocol'

// Why (#20940): this module owns the request half of the shared usage scan
// worker — FIFO one-at-a-time dispatch, a per-scan deadline, respawn-on-fault —
// while WorkerThreadRequestQueue owns the queue mechanics and
// LazyWorkerThreadHost owns the thread's lifetime. The default spawn and the
// process-wide singleton live in usage-scan-worker-spawn.ts.

// Why this long: a first scan of a multi-gigabyte history is legitimately
// minutes, and before the worker existed these scans had no deadline at all. A
// shorter one would fail scans that used to succeed; this only backstops a
// wedged thread.
export const USAGE_SCAN_TIMEOUT_MS = 10 * 60_000
// One user action refreshes several providers in a burst, and the store's own
// staleness window is 5 minutes. Long enough to serve a burst, short enough that
// an idle app is not holding a thread.
export const IDLE_TEARDOWN_MS = 60_000
export const MAX_CONSECUTIVE_DEATHS = 3

/** Thrown when no worker could be started at all, as distinct from a fault. */
export class UsageScanWorkerUnavailableError extends Error {}

type ProviderScanResult<TSource, TSession, TDaily> = {
  source: TSource[]
  sessions: TSession[]
  dailyAggregates: TDaily[]
}

/**
 * Main-thread bridge that runs first-party usage scans on a worker thread.
 * Every route fails closed: a worker that cannot spawn, times out, or crashes
 * rejects, and the caller's store records a scan error and keeps the previous
 * projection rather than moving the parse back onto the main thread.
 */
export class UsageScanWorkerClient {
  private readonly queue: WorkerThreadRequestQueue<UsageScanWorkerRequest, UsageScanWorkerResponse>

  constructor(options: { workerFactory: WorkerThreadFactory; log?: (message: string) => void }) {
    const log = options.log ?? ((message: string) => console.warn(message))
    this.queue = new WorkerThreadRequestQueue({
      factory: options.workerFactory,
      idleTeardownMs: IDLE_TEARDOWN_MS,
      maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
      createUnavailableError: (message) => new UsageScanWorkerUnavailableError(message),
      describeTimeout: (timeoutMs) => `Usage scan worker timed out after ${timeoutMs}ms`,
      describeExit: (code) => `Usage scan worker exited with code ${code}`,
      describeCrashLoop: (lastError) => `Usage scan worker crashed repeatedly (${lastError})`,
      // Why: never fall back to scanning on the main thread here. A missing
      // bundle or a resource-exhausted spawn must surface as a scan error, not
      // reintroduce the main-process occupancy this boundary exists to remove.
      onUnavailable: (err) =>
        log(`[usage-scan] worker unavailable; usage scans will report an error. ${message(err)}`)
    })
  }

  /**
   * Run one provider's scan on the worker.
   * @param body - Provider id, worktree refs, and that provider's previous cache.
   * @returns The worker's value for that provider.
   */
  async scan(body: UsageScanWorkerRequestBody): Promise<UsageScanWorkerValue> {
    const response = await this.queue.dispatch((id) => ({ ...body, id }), USAGE_SCAN_TIMEOUT_MS)
    if (!response.ok) {
      throw new Error(response.error)
    }
    return response.value
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A response for the wrong provider means the worker and client disagree on the protocol. */
function wrongProvider(expected: UsageScanWorkerProviderId, actual: string): Error {
  return new Error(`Usage scan worker answered for ${actual}, expected ${expected}`)
}

/**
 * Scan Claude usage transcripts on the shared worker.
 * @param scan - Dispatch function, injected so tests need no real thread.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param previous - Last scan's per-file cache.
 * @returns Processed files plus the session and daily projections.
 */
export async function scanClaudeUsageOnWorker(
  scan: (body: UsageScanWorkerRequestBody) => Promise<UsageScanWorkerValue>,
  worktrees: UsageScanWorktreeRef[],
  previous: ClaudeUsagePersistedFile[]
): Promise<
  ProviderScanResult<ClaudeUsagePersistedFile, ClaudeUsageSession, ClaudeUsageDailyAggregate>
> {
  const value = await scan({ providerId: 'claude', worktrees, previous })
  if (value.providerId !== 'claude') {
    throw wrongProvider('claude', value.providerId)
  }
  return value
}

/**
 * Scan Codex rollouts on the shared worker.
 * @param scan - Dispatch function, injected so tests need no real thread.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param previous - Last scan's per-file cache.
 * @returns Processed files plus the session and daily projections.
 */
export async function scanCodexUsageOnWorker(
  scan: (body: UsageScanWorkerRequestBody) => Promise<UsageScanWorkerValue>,
  worktrees: UsageScanWorktreeRef[],
  previous: CodexUsagePersistedFile[]
): Promise<
  ProviderScanResult<CodexUsagePersistedFile, CodexUsageSession, CodexUsageDailyAggregate>
> {
  const value = await scan({ providerId: 'codex', worktrees, previous })
  if (value.providerId !== 'codex') {
    throw wrongProvider('codex', value.providerId)
  }
  return value
}

/**
 * Scan OpenCode usage databases on the shared worker.
 * @param scan - Dispatch function, injected so tests need no real thread.
 * @param worktrees - Worktree refs used to attribute usage.
 * @param previous - Last scan's per-database cache.
 * @returns Processed databases plus the session and daily projections.
 */
export async function scanOpenCodeUsageOnWorker(
  scan: (body: UsageScanWorkerRequestBody) => Promise<UsageScanWorkerValue>,
  worktrees: UsageScanWorktreeRef[],
  previous: OpenCodeUsagePersistedDatabase[]
): Promise<
  ProviderScanResult<
    OpenCodeUsagePersistedDatabase,
    OpenCodeUsageSession,
    OpenCodeUsageDailyAggregate
  >
> {
  const value = await scan({ providerId: 'opencode', worktrees, previous })
  if (value.providerId !== 'opencode') {
    throw wrongProvider('opencode', value.providerId)
  }
  return value
}
