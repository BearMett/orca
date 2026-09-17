import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCodexRolloutResumeState,
  resolveCodexRolloutResume
} from './codex-rollout-resume-state'
import type { CodexUsageParseContext } from './codex-usage-record-parser'
import type { CodexUsagePersistedFile } from './types'

/** Mirrors HEAD_WINDOW_BYTES / BOUNDARY_WINDOW_BYTES in the module under test. */
const WINDOW_BYTES = 4096

const context: CodexUsageParseContext = {
  sessionId: 'session-resume-state',
  sessionCwd: null,
  currentCwd: null,
  currentModel: null,
  previousTotals: null
}

let workDir: string

function writeRollout(name: string, bytes: number): string {
  const filePath = join(workDir, name)
  writeFileSync(filePath, 'x'.repeat(bytes), 'utf-8')
  return filePath
}

function persistedFile(
  filePath: string,
  parseResumeState: CodexUsagePersistedFile['parseResumeState']
): CodexUsagePersistedFile {
  const fileStat = statSync(filePath)
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    sessions: [],
    dailyAggregates: [],
    ownedEventKeys: [],
    hasDeferredClaims: false,
    parseResumeState
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'orca-codex-resume-state-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('buildCodexRolloutResumeState', () => {
  // Without the short-read guard the digest is recorded over whatever bytes did
  // arrive. A later scan hashes the same too-short range, gets the same digest,
  // and accepts a resume point past EOF — so the caller resumes over history
  // that is no longer in the file.
  it('refuses to record an offset the file no longer reaches', async () => {
    const filePath = writeRollout('short-prefix.jsonl', 512)

    await expect(buildCodexRolloutResumeState(filePath, 900, context)).resolves.toBeNull()
  })

  // Same guard, disjoint-window layout: the head window is fully readable and
  // only the boundary window falls past the end of the file.
  it('refuses when only the boundary window falls past the end of the file', async () => {
    const filePath = writeRollout('short-boundary.jsonl', 3 * WINDOW_BYTES)

    await expect(
      buildCodexRolloutResumeState(filePath, 4 * WINDOW_BYTES, context)
    ).resolves.toBeNull()
  })

  it('records an offset the file still reaches', async () => {
    const filePath = writeRollout('full-prefix.jsonl', 3 * WINDOW_BYTES)

    const state = await buildCodexRolloutResumeState(filePath, 3 * WINDOW_BYTES, context)

    expect(state?.parsedBytes).toBe(3 * WINDOW_BYTES)
    expect(state?.headDigest).toMatch(new RegExp(`^${WINDOW_BYTES}:`))
  })
})

describe('resolveCodexRolloutResume', () => {
  it('rejects a recorded offset once the file has been truncated past it', async () => {
    const filePath = writeRollout('truncated.jsonl', 3 * WINDOW_BYTES)
    const state = await buildCodexRolloutResumeState(filePath, 3 * WINDOW_BYTES, context)
    expect(state).not.toBeNull()
    const previous = persistedFile(filePath, state)

    writeRollout('truncated.jsonl', WINDOW_BYTES)

    await expect(resolveCodexRolloutResume(filePath, previous)).resolves.toBeNull()
  })

  it('accepts a recorded offset when the file only grew', async () => {
    const filePath = writeRollout('grown.jsonl', 3 * WINDOW_BYTES)
    const state = await buildCodexRolloutResumeState(filePath, 3 * WINDOW_BYTES, context)
    const previous = persistedFile(filePath, state)

    writeRollout('grown.jsonl', 4 * WINDOW_BYTES)

    await expect(resolveCodexRolloutResume(filePath, previous)).resolves.toEqual(state)
  })
})
