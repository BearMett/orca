/**
 * Decides whether a grown rollout can be parsed from where the last scan
 * stopped. A wrong answer here silently corrupts usage totals, so every check
 * fails closed: anything unproven falls back to a full reparse.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { CodexUsageParseContext } from './codex-usage-record-parser'
import type { CodexUsageParseResumeState, CodexUsagePersistedFile } from './types'

/** Bytes hashed immediately before the resume offset. Large enough to span a
 *  whole token_count record, small enough that verifying it is free next to
 *  re-reading a multi-megabyte rollout. */
const BOUNDARY_WINDOW_BYTES = 4096

async function readBoundaryDigest(filePath: string, parsedBytes: number): Promise<string | null> {
  const start = Math.max(0, parsedBytes - BOUNDARY_WINDOW_BYTES)
  const expectedBytes = parsedBytes - start
  if (expectedBytes <= 0) {
    return `0:${parsedBytes}`
  }
  const hash = createHash('sha256')
  let readBytes = 0
  const stream = createReadStream(filePath, { start, end: parsedBytes - 1 })
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(buffer)
    readBytes += buffer.length
  }
  // A short read means the file no longer reaches the offset we recorded.
  return readBytes === expectedBytes ? `${expectedBytes}:${hash.digest('hex')}` : null
}

async function readPhysicalFileId(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath)
    return fileStat.ino === 0 ? null : `${fileStat.dev}:${fileStat.ino}`
  } catch {
    return null
  }
}

function isUsableResumeState(
  resume: CodexUsageParseResumeState | null | undefined
): resume is CodexUsageParseResumeState {
  return (
    resume != null &&
    Number.isInteger(resume.parsedBytes) &&
    resume.parsedBytes >= 0 &&
    typeof resume.boundaryDigest === 'string' &&
    typeof resume.sessionId === 'string'
  )
}

export async function buildCodexRolloutResumeState(
  filePath: string,
  parsedBytes: number,
  context: CodexUsageParseContext
): Promise<CodexUsageParseResumeState | null> {
  const boundaryDigest = await readBoundaryDigest(filePath, parsedBytes)
  if (boundaryDigest === null) {
    return null
  }
  return {
    parsedBytes,
    boundaryDigest,
    physicalFileId: await readPhysicalFileId(filePath),
    sessionId: context.sessionId,
    sessionCwd: context.sessionCwd,
    currentCwd: context.currentCwd,
    currentModel: context.currentModel,
    previousTotals: context.previousTotals
  }
}

/**
 * Returns the resume point only when the recorded prefix is provably still the
 * file's prefix. Deliberately does not consult mtime: filesystems vary in mtime
 * resolution, so an append can land under the mtime the cache already holds.
 * Truncation needs no separate check — a file that no longer reaches the offset
 * cannot produce the recorded boundary digest.
 */
export async function resolveCodexRolloutResume(
  filePath: string,
  previous: CodexUsagePersistedFile | undefined
): Promise<CodexUsageParseResumeState | null> {
  const resume = previous?.parseResumeState
  if (!isUsableResumeState(resume)) {
    return null
  }
  const physicalFileId = await readPhysicalFileId(filePath)
  if (
    resume.physicalFileId !== null &&
    physicalFileId !== null &&
    resume.physicalFileId !== physicalFileId
  ) {
    return null
  }
  const boundaryDigest = await readBoundaryDigest(filePath, resume.parsedBytes)
  return boundaryDigest === resume.boundaryDigest ? resume : null
}
