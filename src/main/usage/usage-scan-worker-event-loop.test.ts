import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { scanCodexUsageFiles } from '../codex-usage/scanner'
import { UsageScanWorkerClient, scanCodexUsageOnWorker } from './usage-scan-worker-client'
import type { UsageScanWorktreeRef } from './usage-provider-contract'

// Why this test exists: "the scan no longer blocks the main process" is not a
// stopwatch claim. It measures the *calling* thread's event-loop utilization —
// the fraction of wall time that thread spent running JS rather than parked in
// the loop's poll phase. A scan on the calling thread pins that near 1.0; the
// same scan on a worker leaves it near 0, because the caller only awaits a
// message. The ratio is self-calibrating, so CI load moves both legs together
// (issue #18788) instead of tipping a fixed millisecond threshold.
//
// The second case is the mutation check kept in the suite: it runs the identical
// scan on the calling thread and asserts the oracle *does* see the occupancy.
// Without it, a worker route that silently degraded to a no-op would still pass.

const FILE_COUNT = 600
const EVENTS_PER_FILE = 60
const EXPECTED_EVENTS = FILE_COUNT * EVENTS_PER_FILE
const TOKENS_PER_EVENT = 200

const WORKTREES: UsageScanWorktreeRef[] = [
  { repoId: 'repo-1', worktreeId: 'wt-1', path: '/tmp/orca-usage-oracle-project', displayName: 'demo' }
]

let corpusRoot = ''
let workerEntryPath = ''

function buildRolloutLines(sessionId: string, seed: number): string {
  const lines: string[] = [
    JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: '/tmp/orca-usage-oracle-project' }
    }),
    JSON.stringify({
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'turn_context',
      payload: { cwd: '/tmp/orca-usage-oracle-project', model: 'gpt-5.6-sol' }
    })
  ]
  // Seeded per file so no two rollouts mint the same event key; identical keys
  // would be deduped as fork copies and shrink the corpus the scan actually parses.
  let total = seed * 10_000_000
  for (let index = 0; index < EVENTS_PER_FILE; index++) {
    total += TOKENS_PER_EVENT
    lines.push(
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 0, 1, 1, 0, index % 60)).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: total,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: total
            },
            last_token_usage: {
              input_tokens: TOKENS_PER_EVENT,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
              total_tokens: TOKENS_PER_EVENT
            }
          },
          // Padding so each line is rollout-shaped rather than trivially short.
          text: 'x'.repeat(200)
        }
      })
    )
  }
  return `${lines.join('\n')}\n`
}

function writeCorpus(root: string): void {
  const sessionsDir = join(root, 'codex-runtime-home', 'home', 'sessions', '2026', '01', '01')
  mkdirSync(sessionsDir, { recursive: true })
  for (let index = 0; index < FILE_COUNT; index++) {
    writeFileSync(
      join(sessionsDir, `rollout-${String(index).padStart(6, '0')}.jsonl`),
      buildRolloutLines(`session-${index}`, index + 1)
    )
  }
}

type Occupancy = {
  /** Fraction of the measured span the calling thread spent running JS. */
  activeRatio: number
  wallMs: number
}

async function measureCallerOccupancy<T>(
  run: () => Promise<T>
): Promise<{ value: T; occupancy: Occupancy }> {
  const before = performance.eventLoopUtilization()
  const startedAt = performance.now()
  const value = await run()
  const wallMs = performance.now() - startedAt
  const delta = performance.eventLoopUtilization(before)
  return { value, occupancy: { activeRatio: delta.active / wallMs, wallMs } }
}

function createWorkerClient(): UsageScanWorkerClient {
  return new UsageScanWorkerClient({
    workerFactory: () => new Worker(workerEntryPath),
    log: () => {}
  })
}

/**
 * Run `fn` with both Codex session lanes pointed at the fixture.
 * Why the real process environment and not the Worker `env` option: that option
 * only replaces the worker's JS-visible `process.env`, while `os.homedir()`
 * reads the OS environment the threads share — so a worker given `HOME` there
 * still scanned the developer's real ~/.codex.
 */
async function withCorpusEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    ORCA_USER_DATA_PATH: process.env.ORCA_USER_DATA_PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE
  }
  process.env.ORCA_USER_DATA_PATH = corpusRoot
  process.env.HOME = corpusRoot
  process.env.USERPROFILE = corpusRoot
  try {
    return await fn()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      restoreEnv(name, value)
    }
  }
}

beforeAll(async () => {
  corpusRoot = mkdtempSync(join(tmpdir(), 'orca-usage-scan-oracle-'))
  writeCorpus(corpusRoot)
  workerEntryPath = join(corpusRoot, 'usage-scan-worker-entry.cjs')
  // Why bundle here: `new Worker` needs JavaScript, and the production entry is
  // emitted by the app build. Bundling the same source keeps the oracle running
  // the real scanner instead of a stand-in.
  await build({
    entryPoints: [resolve(__dirname, 'usage-scan-worker-entry.ts')],
    outfile: workerEntryPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron']
  })
}, 120_000)

afterAll(() => {
  rmSync(corpusRoot, { recursive: true, force: true })
})

describe('usage scan worker event-loop occupancy', () => {
  it('leaves the calling event loop idle while the worker scans', async () => {
    const client = createWorkerClient()
    const { value, occupancy } = await measureCallerOccupancy(() =>
      withCorpusEnv(() => scanCodexUsageOnWorker((body) => client.scan(body), WORKTREES, []))
    )

    // Presence precondition: an empty or skipped scan must not be able to pass
    // the occupancy assertion by simply doing no work.
    expect(value.source).toHaveLength(FILE_COUNT)
    expect(value.sessions).toHaveLength(FILE_COUNT)
    expect(value.dailyAggregates).toHaveLength(1)
    expect(value.dailyAggregates[0]?.eventCount).toBe(EXPECTED_EVENTS)

    expect(occupancy.activeRatio).toBeLessThan(0.5)
  }, 120_000)

  it('sees the occupancy when the same scan runs on the calling thread', async () => {
    // The mutation check, kept resident: this is the pre-worker code path.
    const { value, occupancy } = await measureCallerOccupancy(() =>
      scanCodexUsageOnCallingThread()
    )

    expect(value.processedFiles).toHaveLength(FILE_COUNT)
    expect(value.sessions).toHaveLength(FILE_COUNT)
    expect(occupancy.activeRatio).toBeGreaterThan(0.8)
  }, 120_000)
})

function scanCodexUsageOnCallingThread(): ReturnType<typeof scanCodexUsageFiles> {
  return withCorpusEnv(() => scanCodexUsageFiles(WORKTREES, []))
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}
