import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'

const { getPathMock, homedirMock, streamReads, onStreamOpen } = vi.hoisted(() => {
  const streamReads: { path: string; bytes: number }[] = []
  return {
    getPathMock: vi.fn<(name: string) => string>(),
    homedirMock: vi.fn<() => string>(),
    streamReads,
    // Seam for mutating the tree mid-scan, between two files' parse reads.
    onStreamOpen: { current: null as ((path: string, bounded: boolean) => void) | null }
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

// The perf oracle: every byte the scanner streams out of a session file.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    createReadStream: (
      path: Parameters<typeof actual.createReadStream>[0],
      options?: Parameters<typeof actual.createReadStream>[1]
    ) => {
      const filePath = String(path)
      const range = typeof options === 'object' && options !== null ? options : {}
      const start = range.start ?? 0
      const size = actual.statSync(filePath).size
      const stop = range.end === undefined ? size : Math.min(size, range.end + 1)
      streamReads.push({ path: filePath, bytes: Math.max(0, stop - start) })
      onStreamOpen.current?.(filePath, range.end !== undefined)
      return actual.createReadStream(path, options)
    }
  }
})

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { scanCodexUsageFiles } from './scanner'
import type { CodexUsagePersistedFile } from './types'

/** Mirrors BOUNDARY_WINDOW_BYTES in codex-rollout-resume-state.ts. */
const BOUNDARY_WINDOW_BYTES = 4096

const originalCodexHome = process.env.CODEX_HOME
let fakeHomeDir: string
let userDataDir: string
let sessionsDir: string
let previousUserDataPath: string | undefined

function usageRecord(timestamp: string, inputTokens: number, totalInputTokens: number): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens
        },
        total_token_usage: {
          input_tokens: totalInputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalInputTokens
        }
      }
    }
  })}\n`
}

function totalOnlyUsageRecord(timestamp: string, totalInputTokens: number): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        total_token_usage: {
          input_tokens: totalInputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalInputTokens
        }
      }
    }
  })}\n`
}

function sessionMeta(id: string): string {
  return `${JSON.stringify({
    type: 'session_meta',
    payload: { id, cwd: join(fakeHomeDir, 'repo') }
  })}\n`
}

/** Records numbered [from, to), each worth one token, cumulative totals. */
function usageRecordRange(from: number, to: number): string {
  let out = ''
  for (let index = from; index < to; index++) {
    const minute = String(index % 60).padStart(2, '0')
    // Midday UTC keeps the derived local day stable across test-runner zones.
    const hour = String(12 + (Math.floor(index / 60) % 4)).padStart(2, '0')
    out += usageRecord(`2026-05-26T${hour}:${minute}:00.000Z`, 1, index + 1)
  }
  return out
}

function bytesReadFor(filePath: string): number {
  return streamReads
    .filter((entry) => entry.path === filePath)
    .reduce((total, entry) => total + entry.bytes, 0)
}

function totalTokens(aggregates: { totalTokens: number }[]): number {
  return aggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
}

beforeEach(() => {
  delete process.env.CODEX_HOME
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-incremental-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-incremental-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  streamReads.length = 0
  onStreamOpen.current = null
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('scanCodexUsageFiles incremental append', () => {
  it('re-reads only the appended bytes when a rollout grows', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-grow.jsonl')
    writeFileSync(rolloutPath, `${sessionMeta('session-grow')}${usageRecordRange(0, 200)}`, 'utf-8')
    const sizeBeforeAppend = statSync(rolloutPath).size

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(200)
    expect(bytesReadFor(rolloutPath)).toBeGreaterThanOrEqual(sizeBeforeAppend)

    streamReads.length = 0
    appendFileSync(rolloutPath, usageRecordRange(200, 202), 'utf-8')
    const appendedBytes = statSync(rolloutPath).size - sizeBeforeAppend

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(202)
    expect(second.sessions[0]?.eventCount).toBe(202)

    // The defect: the scanner restarts at byte 0 and re-reads the whole file.
    // The fix reads the appended bytes plus three bounded windows: a head and a
    // boundary window to verify the cached prefix, then the moved boundary to
    // record the new resume point. The head window is carried, not re-read.
    expect(bytesReadFor(rolloutPath)).toBeLessThan(sizeBeforeAppend)
    expect(bytesReadFor(rolloutPath)).toBeLessThanOrEqual(appendedBytes + 3 * BOUNDARY_WINDOW_BYTES)
  })

  it('carries cumulative token totals across the resume boundary', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-cumulative.jsonl')
    writeFileSync(
      rolloutPath,
      [
        sessionMeta('session-cumulative'),
        totalOnlyUsageRecord('2026-05-26T12:00:00.000Z', 100),
        totalOnlyUsageRecord('2026-05-26T12:01:00.000Z', 250)
      ].join(''),
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(250)

    // Only the running total is on the wire, so the appended record's delta
    // depends entirely on the totals carried out of the previous scan.
    appendFileSync(rolloutPath, totalOnlyUsageRecord('2026-05-26T12:02:00.000Z', 400), 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(400)
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
  })

  it('still reuses an untouched rollout without reading it', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-idle.jsonl')
    writeFileSync(rolloutPath, `${sessionMeta('session-idle')}${usageRecordRange(0, 50)}`, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    streamReads.length = 0

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(bytesReadFor(rolloutPath)).toBe(0)
    expect(totalTokens(second.dailyAggregates)).toBe(50)
  })

  it('tracks byte offsets through CRLF line endings', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-crlf.jsonl')
    const toCrlf = (text: string): string => text.replaceAll('\n', '\r\n')
    writeFileSync(
      rolloutPath,
      toCrlf(`${sessionMeta('session-crlf')}${usageRecordRange(0, 30)}`),
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(30)

    appendFileSync(rolloutPath, toCrlf(usageRecordRange(30, 33)), 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(33)
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  it('matches a full rescan after repeated appends', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-chatty.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-chatty')}${usageRecordRange(0, 10)}`,
      'utf-8'
    )

    let processedFiles: CodexUsagePersistedFile[] = []
    let scanned = await scanCodexUsageFiles([], processedFiles)
    processedFiles = scanned.processedFiles

    for (let round = 1; round <= 5; round++) {
      appendFileSync(rolloutPath, usageRecordRange(round * 10, round * 10 + 10), 'utf-8')
      scanned = await scanCodexUsageFiles([], processedFiles)
      processedFiles = scanned.processedFiles
    }

    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(scanned.dailyAggregates)).toBe(60)
    expect(scanned.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(scanned.sessions).toEqual(fromScratch.sessions)
  })

  it('falls back to a full reparse when a rollout is truncated', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-truncated.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-truncated')}${usageRecordRange(0, 30)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(30)

    writeFileSync(rolloutPath, `${sessionMeta('session-truncated')}${usageRecordRange(0, 5)}`)
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(5)
  })

  // The prefix is verified in the scanner's first pass and read in its second,
  // so a rollout can shrink in between. The merged projection then keeps the
  // whole pre-truncation history while the file is re-stat'd to its new, small
  // size — a cache entry the reuse path matches on and serves forever.
  it('reparses from the start when a rollout shrinks after its prefix was verified', async () => {
    const driverPath = join(sessionsDir, 'aaaa-driver.jsonl')
    const targetPath = join(sessionsDir, 'zzzz-shrinker.jsonl')
    writeFileSync(driverPath, `${sessionMeta('session-driver')}${usageRecordRange(120, 123)}`)
    writeFileSync(targetPath, `${sessionMeta('session-shrinker')}${usageRecordRange(0, 20)}`)

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(23)

    appendFileSync(driverPath, usageRecordRange(123, 124), 'utf-8')
    appendFileSync(targetPath, usageRecordRange(20, 22), 'utf-8')
    const truncated = `${sessionMeta('session-shrinker')}${usageRecordRange(0, 5)}`
    onStreamOpen.current = (path, bounded) => {
      // The driver's unbounded parse read runs after every file's prefix has
      // been verified and before the target is re-stat'd: the exact window.
      if (path === driverPath && !bounded) {
        onStreamOpen.current = null
        writeFileSync(targetPath, truncated, 'utf-8')
      }
    }

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(onStreamOpen.current).toBeNull()
    expect(totalTokens(second.dailyAggregates)).toBe(9)

    // The kill: size and mtime now agree with disk, so a stale merged total
    // would be reused unconditionally and no digest would ever get to reject it.
    const cached = second.processedFiles.find((file) => file.path === targetPath)
    expect(cached?.size).toBe(statSync(targetPath).size)
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(totalTokens(third.dailyAggregates)).toBe(9)
  })

  it('falls back to a full reparse when a rollout is rewritten at the same size', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-replaced.jsonl')
    const original = `${sessionMeta('session-a')}${usageRecordRange(0, 20)}`
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(20)

    // Byte-identical length, different content: only the year changes.
    const replacement = original.replaceAll('2026-05-26T', '2027-05-26T')
    expect(replacement.length).toBe(original.length)
    writeFileSync(rolloutPath, replacement, 'utf-8')
    expect(statSync(rolloutPath).size).toBe(original.length)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  it('falls back to a full reparse when a rewritten rollout also grows', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-rotated.jsonl')
    writeFileSync(rolloutPath, `${sessionMeta('session-a')}${usageRecordRange(0, 20)}`, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(20)

    // Rotation: a fresh, longer file lands at the same path.
    rmSync(rolloutPath)
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-b')}${usageRecordRange(0, 20).replaceAll('2026-', '2027-')}${usageRecordRange(20, 25).replaceAll('2026-', '2027-')}`,
      'utf-8'
    )

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(25)
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(second.sessions).toEqual(fromScratch.sessions)
  })

  /** A rollout whose leading records differ but whose trailing records — more
   *  than a boundary window of them — are byte-identical, at the same length.
   *  The boundary digest is blind to this by construction. */
  function prefixSwapPair(sessionId: string): { original: string; replacement: string } {
    const sharedSuffix = usageRecordRange(20, 40)
    expect(sharedSuffix.length).toBeGreaterThan(BOUNDARY_WINDOW_BYTES)
    let swappedPrefix = ''
    for (let index = 0; index < 20; index++) {
      const minute = String(index % 60).padStart(2, '0')
      swappedPrefix += usageRecord(`2026-05-26T12:${minute}:00.000Z`, 3, index + 1)
    }
    const original = `${sessionMeta(sessionId)}${usageRecordRange(0, 20)}${sharedSuffix}`
    const replacement = `${sessionMeta(sessionId)}${swappedPrefix}${sharedSuffix}`
    expect(replacement.length).toBe(original.length)
    return { original, replacement }
  }

  // The mirror image of the prefix swap: the head window is byte-identical, so
  // only the boundary window is left to notice that trailing records changed.
  it('falls back to a full reparse when the records before the offset changed', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-tail-swap.jsonl')
    const sharedHead = `${sessionMeta('session-tail')}${usageRecordRange(0, 20)}`
    expect(sharedHead.length).toBeGreaterThan(BOUNDARY_WINDOW_BYTES)
    let heavierTail = ''
    for (let index = 20; index < 30; index++) {
      const minute = String(index % 60).padStart(2, '0')
      heavierTail += usageRecord(`2026-05-26T12:${minute}:00.000Z`, 3, index + 1)
    }
    const original = `${sharedHead}${usageRecordRange(20, 30)}`
    const replacement = `${sharedHead}${heavierTail}`
    expect(replacement.length).toBe(original.length)
    // The windows must be disjoint, or the head digest would span the whole
    // prefix and this would not isolate the boundary window.
    expect(original.length).toBeGreaterThan(2 * BOUNDARY_WINDOW_BYTES)
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(30)

    writeFileSync(rolloutPath, replacement, 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(50)
  })

  // Rotation: the path is unlinked and recreated. `physicalFileId` cannot carry
  // this — ext4 and overlayfs hand the new file the inode the old one freed —
  // so the head window is what has to catch it on Linux.
  it('falls back to a full reparse when a recreated rollout swapped its prefix', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-prefix-swap-rotated.jsonl')
    const { original, replacement } = prefixSwapPair('session-prefix-rotated')
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

    rmSync(rolloutPath)
    writeFileSync(rolloutPath, replacement, 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(80)
  })

  // The same swap written in place. No inode changes on any platform, so the
  // head window is the only guard left — this is the case that was missed on
  // macOS too, not just on Linux.
  it('falls back to a full reparse when a prefix was rewritten in place', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-prefix-swap-in-place.jsonl')
    const { original, replacement } = prefixSwapPair('session-prefix-in-place')
    writeFileSync(rolloutPath, original, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)

    const inodeBefore = statSync(rolloutPath).ino
    writeFileSync(rolloutPath, replacement, 'utf-8')
    // Pins why this test is not a duplicate of the rotation case above.
    expect(statSync(rolloutPath).ino).toBe(inodeBefore)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
    expect(totalTokens(second.dailyAggregates)).toBe(80)
  })

  // A new session starts smaller than the head window, so its whole prefix is
  // hashed as one window; once it outgrows both windows the layout switches to
  // two disjoint ones. Resuming has to survive that switch instead of silently
  // falling back to a full reparse on every later scan.
  it('keeps resuming after the prefix outgrows the head window', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-outgrows-head.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-outgrows')}${usageRecordRange(0, 3)}`,
      'utf-8'
    )
    expect(statSync(rolloutPath).size).toBeLessThan(BOUNDARY_WINDOW_BYTES)

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(3)

    appendFileSync(rolloutPath, usageRecordRange(3, 40), 'utf-8')
    const sizeBeforeLastAppend = statSync(rolloutPath).size
    expect(sizeBeforeLastAppend).toBeGreaterThan(2 * BOUNDARY_WINDOW_BYTES)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(40)

    streamReads.length = 0
    appendFileSync(rolloutPath, usageRecordRange(40, 42), 'utf-8')
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(totalTokens(third.dailyAggregates)).toBe(42)
    // A stale head digest recorded under the old layout would force this scan
    // to re-read the file from byte 0.
    expect(bytesReadFor(rolloutPath)).toBeLessThan(sizeBeforeLastAppend)
  })

  it('does not double-count a record completed after a partial trailing line', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-partial.jsonl')
    const complete = usageRecordRange(0, 3)
    const pending = usageRecord('2026-05-26T12:59:00.000Z', 1, 4)
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-partial')}${complete}${pending.slice(0, 40)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(3)

    // The writer finishes the line and appends one more record.
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-partial')}${complete}${pending}${usageRecordRange(4, 5)}`,
      'utf-8'
    )

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(5)
    expect(second.sessions[0]?.eventCount).toBe(5)
  })

  // The case above stops at the parser: its tail is truncated JSON, so no event
  // comes out of it. A tail that is complete JSON with only the newline missing
  // is counted, yet the next scan re-reads it — the resume offset must exclude
  // it or the record lands in the totals twice.
  it('does not double-count a counted tail whose newline was not yet written', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-unflushed-newline.jsonl')
    const complete = usageRecordRange(0, 3)
    const pending = usageRecord('2026-05-26T12:59:00.000Z', 1, 4)
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-unflushed')}${complete}${pending.slice(0, -1)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    // The unterminated line is valid JSON, so it is parsed and counted here.
    expect(totalTokens(first.dailyAggregates)).toBe(4)
    expect(first.sessions[0]?.eventCount).toBe(4)

    // The writer flushes the newline and appends one more record.
    appendFileSync(rolloutPath, `\n${usageRecordRange(4, 5)}`, 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const fromScratch = await scanCodexUsageFiles([], [])
    expect(totalTokens(second.dailyAggregates)).toBe(5)
    expect(second.sessions[0]?.eventCount).toBe(5)
    expect(second.dailyAggregates).toEqual(fromScratch.dailyAggregates)
  })

  it('reads appended bytes only when the append shares the cached mtime', async () => {
    const rolloutPath = join(sessionsDir, 'rollout-same-mtime.jsonl')
    writeFileSync(
      rolloutPath,
      `${sessionMeta('session-same-mtime')}${usageRecordRange(0, 40)}`,
      'utf-8'
    )
    const sizeBeforeAppend = statSync(rolloutPath).size

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(40)
    streamReads.length = 0

    appendFileSync(rolloutPath, usageRecordRange(40, 42), 'utf-8')
    // A coarse-mtime filesystem reports the append under the cached mtime.
    const coarseMtimeMs = statSync(rolloutPath).mtimeMs
    const cached = first.processedFiles.map((file) =>
      file.path === rolloutPath ? { ...file, mtimeMs: coarseMtimeMs } : file
    )

    const second = await scanCodexUsageFiles([], cached)
    expect(totalTokens(second.dailyAggregates)).toBe(42)
    expect(second.sessions[0]?.eventCount).toBe(42)
    expect(bytesReadFor(rolloutPath)).toBeLessThan(sizeBeforeAppend)
  })

  it('keeps fork ownership when the owning rollout grows incrementally', async () => {
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-fork.jsonl')
    const copiedPrefix = `${sessionMeta('session-fork')}${usageRecordRange(0, 4)}`
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    writeFileSync(forkPath, `${copiedPrefix}${usageRecordRange(4, 6)}`, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(6)
    expect(first.processedFiles.find((file) => file.path === originalPath)?.ownedEventKeys).toEqual(
      expect.arrayContaining([expect.any(String)])
    )

    appendFileSync(originalPath, usageRecordRange(6, 8), 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    // 4 shared + 2 fork-only + 2 newly appended, each counted exactly once.
    expect(totalTokens(second.dailyAggregates)).toBe(8)
    const originalAfter = second.processedFiles.find((file) => file.path === originalPath)
    const forkAfter = second.processedFiles.find((file) => file.path === forkPath)
    expect(originalAfter?.ownedEventKeys).toHaveLength(6)
    expect(forkAfter?.ownedEventKeys).toHaveLength(2)
    expect(forkAfter?.hasDeferredClaims).toBe(true)
  })

  it('keeps a new fork from re-claiming events a resumed rollout still owns', async () => {
    const originalPath = join(sessionsDir, 'aaaa-origin.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-late-fork.jsonl')
    const copiedPrefix = `${sessionMeta('session-late')}${usageRecordRange(0, 4)}`
    writeFileSync(originalPath, copiedPrefix, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(totalTokens(first.dailyAggregates)).toBe(4)

    // The owner grows (resume path) in the same cycle a fork of its prefix appears.
    appendFileSync(originalPath, usageRecordRange(4, 6), 'utf-8')
    writeFileSync(forkPath, `${copiedPrefix}${usageRecordRange(6, 7)}`, 'utf-8')

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(7)
    const forkAfter = second.processedFiles.find((file) => file.path === forkPath)
    expect(forkAfter?.ownedEventKeys).toHaveLength(1)
    expect(forkAfter?.hasDeferredClaims).toBe(true)
  })

  it('still reclaims deferred fork claims after an incremental append', async () => {
    const originalPath = join(sessionsDir, 'aaaa-owner.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-deferred.jsonl')
    const copiedPrefix = `${sessionMeta('session-deferred')}${usageRecordRange(0, 4)}`
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    writeFileSync(forkPath, `${copiedPrefix}${usageRecordRange(4, 6)}`, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    // The deferring fork is the one that grows, so its deferred flag has to
    // survive the incremental merge or the reclaim below never runs.
    appendFileSync(forkPath, usageRecordRange(6, 8), 'utf-8')
    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(totalTokens(second.dailyAggregates)).toBe(8)
    expect(second.processedFiles.find((file) => file.path === forkPath)?.hasDeferredClaims).toBe(
      true
    )

    rmSync(originalPath)
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(third.processedFiles).toHaveLength(1)
    expect(third.processedFiles[0]?.ownedEventKeys).toHaveLength(8)
    expect(totalTokens(third.dailyAggregates)).toBe(8)
  })
})
