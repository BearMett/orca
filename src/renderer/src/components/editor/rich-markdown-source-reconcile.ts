import {
  applyPatches,
  cleanupEfficiency,
  cleanupSemantic,
  makeDiff,
  makePatches
} from '@sanity/diff-match-patch'
import {
  getUtf8ByteLengthForCodePoint,
  readUtf8CodePointAt
} from '../../../../shared/utf8-byte-limits'

// Why: cap document size in UTF-16 code units (`.length`) since re-parse cost scales with length — the per-commit throwaway TipTap safety re-parse (~50-67ms here) must stay under the 300ms serialize debounce so it can't stall the main thread on slow/SSH hosts.
const RECONCILE_SIZE_CAP_CODE_UNITS = 50_000

// Why: dmp's default 1s search freezes the renderer on replacement-heavy paths; a coarse timed-out diff is safe since the round-trip proof below rejects bad placements.
const RECONCILE_DIFF_TIMEOUT_SECONDS = 0.01

export type ReconcileSerializedMarkdownParams = {
  /** Current on-disk source bytes (possibly non-canonical, possibly CRLF). */
  originalSource: string
  /** Canonical serialization of `originalSource` (what getMarkdown returns unedited). */
  baseCanonical: string
  /** Canonical serialization after the user's edit (getMarkdown, always LF). */
  edited: string
  /**
   * Re-serializes reconciled bytes through the live editor's pipeline; injected so the reconcile logic is unit-testable without a DOM.
   * Returns null when the throwaway serializer fails (treated as a safety mismatch → canonical fallback).
   */
  roundTrip: (markdown: string) => string | null
}

/**
 * Canonical fallback: `edited` content, the source's dominant EOL, and the
 * single POSIX trailing newline getMarkdown omitted.
 */
export function restoreCanonicalMarkdownSourceEof(edited: string, source: string): string {
  return restoreEol(
    attachPosixTrailingNewline(toLf(edited), toLf(source)),
    detectDominantEol(source)
  )
}

/**
 * Carries the user's edit into the original source style so untouched regions keep their non-canonical bytes.
 * Falls back to canonical `edited` when the transform can't be proven render-equivalent, so it never corrupts or relocates content.
 */
export function reconcileSerializedMarkdown({
  originalSource,
  baseCanonical,
  edited,
  roundTrip
}: ReconcileSerializedMarkdownParams): string {
  // Branch 1: no semantic change vs the unedited doc → return the original bytes verbatim, zero disk churn.
  if (edited === baseCanonical) {
    return originalSource
  }

  // Work in LF space (getMarkdown emits LF, `originalSource` may be CRLF → CRLF fuzzy-matches poorly); restoreEol on every non-verbatim return keeps a uniform-CRLF file from silently flipping to LF.
  const eol = detectDominantEol(originalSource)
  const originalSourceLf = toLf(originalSource)
  const baseLf = toLf(baseCanonical)
  const editedLf = toLf(edited)

  // Branch 2: source == edited except for EOL/trailing newlines → carry the source's EOL onto the edit and skip the re-parse; guards avoid a spurious `&nbsp;` paragraph and dropping a real trailing block.
  const originalTrailingNewlines = originalSourceLf.match(/\n+$/)?.[0] ?? ''
  if (
    originalTrailingNewlines.length <= 1 &&
    !editedLf.endsWith('\n') &&
    stripTrailingNewlines(originalSourceLf) === stripTrailingNewlines(baseLf)
  ) {
    return restoreEol(editedLf + originalTrailingNewlines, eol)
  }

  // Branch 3: oversize → bounded-cost canonical fallback (today's behavior).
  if (
    Math.max(originalSource.length, baseCanonical.length, edited.length) >
    RECONCILE_SIZE_CAP_CODE_UNITS
  ) {
    return restoreCanonicalMarkdownSourceEof(edited, originalSource)
  }

  // Why: dmp's half-match accelerator ignores the diff deadline (100ms+ on repeated seeds), so bail to canonical for highly repetitive replacements.
  if (hasRepeatedHalfMatchSeed(baseLf, editedLf)) {
    return restoreCanonicalMarkdownSourceEof(edited, originalSource)
  }

  const prove = (lf: string): boolean => {
    const reparsed = roundTrip(lf)
    return reparsed !== null && normalizeForSafety(reparsed) === normalizeForSafety(editedLf)
  }

  // Why: getMarkdown omits the source's single trailing `\n`, so an EOF hunk locates after it and fails the proof; patch the bodies first.
  if (!baseLf.endsWith('\n') && originalTrailingNewlines.length === 1) {
    const patched = patchDivergentSource(
      stripTrailingNewlines(originalSourceLf),
      baseLf,
      stripTrailingNewlines(editedLf)
    )
    if (patched !== null) {
      // Why `||` not `+`: edited's trailing run is semantic; concatenating the POSIX `\n` would become `\n\n\n`.
      const trailing = (editedLf.match(/\n+$/)?.[0] ?? '') || originalTrailingNewlines
      const reconciledLf = patched + trailing
      if (prove(reconciledLf)) {
        return restoreEol(attachPosixTrailingNewline(reconciledLf, originalSourceLf), eol)
      }
    }
  }

  const reconciledLf = patchDivergentSource(originalSourceLf, baseLf, editedLf)
  if (reconciledLf !== null && prove(reconciledLf)) {
    return restoreEol(attachPosixTrailingNewline(reconciledLf, originalSourceLf), eol)
  }
  return restoreCanonicalMarkdownSourceEof(edited, originalSource)
}

/** Null when any hunk failed to locate (Branch 5 for this attempt). */
function patchDivergentSource(source: string, base: string, edited: string): string | null {
  let diffs = makeDiff(base, edited, {
    checkLines: true,
    timeout: RECONCILE_DIFF_TIMEOUT_SECONDS
  })
  if (diffs.length > 2) {
    diffs = cleanupSemantic(diffs)
    diffs = cleanupEfficiency(diffs)
  }
  const patches = makePatches(base, diffs)
  // Why: applyPatches decodes starts as UTF-8 offsets even though makePatches returns UTF-16 indices; encode against the divergent text being patched so decoding preserves the fuzzy-match seed.
  const utf8Offsets = getUtf8OffsetsAtCodeUnitIndices(
    source,
    patches.flatMap((patch) => [patch.start1, patch.start2])
  )
  for (const patch of patches) {
    patch.start1 = utf8Offsets.get(patch.start1) ?? 0
    patch.start2 = utf8Offsets.get(patch.start2) ?? 0
  }
  const [patched, results] = applyPatches(patches, source)
  return results.some((applied) => !applied) ? null : patched
}

function attachPosixTrailingNewline(lfText: string, originalSourceLf: string): string {
  // Exactly one `\n` if the source ended with a newline and the result has none. Do not re-attach a run of length > 1 (`&nbsp;`).
  if (lfText.endsWith('\n') || !originalSourceLf.endsWith('\n')) {
    return lfText
  }
  return `${lfText}\n`
}

function stripTrailingNewlines(lfText: string): string {
  return lfText.replace(/\n+$/, '')
}

function detectDominantEol(text: string): '\n' | '\r\n' {
  const totalLf = (text.match(/\n/g) ?? []).length
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lfOnly = totalLf - crlf
  return crlf > 0 && crlf >= lfOnly ? '\r\n' : '\n'
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreEol(lfText: string, eol: '\n' | '\r\n'): string {
  // lfText is pure LF, so a blind LF→CRLF replace produces no mixed endings.
  return eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText
}

function normalizeForSafety(text: string): string {
  // Why: compare exactly (only CRLF-normalized) — a trailing `\n\n` empty paragraph is semantic, so a lenient trimEnd would mask the trailing-block drift branch 6 must catch.
  return text.replace(/\r\n/g, '\n')
}

function getUtf8OffsetsAtCodeUnitIndices(
  text: string,
  codeUnitIndices: number[]
): Map<number, number> {
  const targets = [...new Set(codeUnitIndices)].sort((a, b) => a - b)
  const offsets = new Map<number, number>()
  let codeUnitIndex = 0
  let byteOffset = 0
  for (const target of targets) {
    const boundedTarget = Math.max(0, Math.min(target, text.length))
    while (codeUnitIndex < boundedTarget) {
      const codePoint = readUtf8CodePointAt(text, codeUnitIndex)
      byteOffset += getUtf8ByteLengthForCodePoint(codePoint)
      codeUnitIndex += codePoint > 0xffff ? 2 : 1
    }
    offsets.set(target, byteOffset)
  }
  return offsets
}

function hasRepeatedHalfMatchSeed(textA: string, textB: string): boolean {
  // Match diff-match-patch's prefix/suffix trimming so a small edit isn't mistaken for a repetitive replacement.
  const minimumLength = Math.min(textA.length, textB.length)
  let prefixLength = 0
  while (
    prefixLength < minimumLength &&
    textA.charCodeAt(prefixLength) === textB.charCodeAt(prefixLength)
  ) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < minimumLength - prefixLength &&
    textA.charCodeAt(textA.length - suffixLength - 1) ===
      textB.charCodeAt(textB.length - suffixLength - 1)
  ) {
    suffixLength += 1
  }
  const middleA = textA.slice(prefixLength, textA.length - suffixLength)
  const middleB = textB.slice(prefixLength, textB.length - suffixLength)
  const longText = middleA.length > middleB.length ? middleA : middleB
  const shortText = middleA.length > middleB.length ? middleB : middleA
  if (longText.length < 4 || shortText.length * 2 < longText.length) {
    return false
  }

  const seedLength = Math.floor(longText.length / 4)
  for (const start of [Math.ceil(longText.length / 4), Math.ceil(longText.length / 2)]) {
    const seed = longText.slice(start, start + seedLength)
    const firstMatch = shortText.indexOf(seed)
    if (firstMatch !== -1 && shortText.includes(seed, firstMatch + 1)) {
      return true
    }
  }
  return false
}
