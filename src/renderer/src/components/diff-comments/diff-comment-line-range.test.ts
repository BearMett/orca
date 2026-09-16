import { describe, expect, it } from 'vitest'
import {
  areLineRangesEqual,
  clampFocusLineToCommentable,
  getSelectionLineRange,
  orderLineRange,
  toDiffCommentLineTarget
} from './diff-comment-line-range'

// One patch hunk covering 10-16, then a gap, then a second hunk at 40-42 — the shape
// `reviewCommentLineNumbers` ships for a PR file.
const HUNK_LINES = new Set([10, 11, 12, 13, 14, 15, 16, 40, 41, 42])

describe('orderLineRange', () => {
  it('orders a range dragged upward', () => {
    expect(orderLineRange(14, 9)).toEqual({ startLine: 9, endLine: 14 })
  })

  it('orders a range dragged downward', () => {
    expect(orderLineRange(9, 14)).toEqual({ startLine: 9, endLine: 14 })
  })
})

describe('toDiffCommentLineTarget', () => {
  it('drops startLine for a single line so the wire shape matches a plain click', () => {
    expect(toDiffCommentLineTarget({ startLine: 12, endLine: 12 })).toEqual({
      lineNumber: 12,
      startLine: undefined
    })
  })

  it('anchors a multi-line note on its last line', () => {
    expect(toDiffCommentLineTarget({ startLine: 9, endLine: 14 })).toEqual({
      lineNumber: 14,
      startLine: 9
    })
  })
})

describe('clampFocusLineToCommentable', () => {
  it('leaves every line reachable when the surface has no commentable-line set', () => {
    expect(clampFocusLineToCommentable(10, 4000, null)).toBe(4000)
  })

  it('stops at the last line of the hunk instead of jumping the gap', () => {
    expect(clampFocusLineToCommentable(12, 41, HUNK_LINES)).toBe(16)
  })

  it('clamps upward drags at the top of the hunk', () => {
    expect(clampFocusLineToCommentable(14, 2, HUNK_LINES)).toBe(10)
  })

  it('keeps a focus that stays inside the hunk', () => {
    expect(clampFocusLineToCommentable(12, 15, HUNK_LINES)).toBe(15)
  })

  it('collapses to the anchor when the very next line is already outside the hunk', () => {
    expect(clampFocusLineToCommentable(16, 30, HUNK_LINES)).toBe(16)
  })

  it('is identity for a focus on the anchor', () => {
    expect(clampFocusLineToCommentable(16, 16, HUNK_LINES)).toBe(16)
  })
})

describe('getSelectionLineRange', () => {
  it('excludes a trailing line the selection only touches at column 1', () => {
    expect(
      getSelectionLineRange({
        startLineNumber: 4,
        startColumn: 3,
        endLineNumber: 7,
        endColumn: 1
      })
    ).toEqual({ startLine: 4, endLine: 6 })
  })

  it('keeps the last line when the selection reaches into it', () => {
    expect(
      getSelectionLineRange({
        startLineNumber: 4,
        startColumn: 3,
        endLineNumber: 7,
        endColumn: 5
      })
    ).toEqual({ startLine: 4, endLine: 7 })
  })

  it('reads a bare cursor as its own line', () => {
    expect(
      getSelectionLineRange({
        startLineNumber: 4,
        startColumn: 1,
        endLineNumber: 4,
        endColumn: 1
      })
    ).toEqual({ startLine: 4, endLine: 4 })
  })
})

describe('areLineRangesEqual', () => {
  it('compares by value, not identity', () => {
    expect(areLineRangesEqual({ startLine: 1, endLine: 3 }, { startLine: 1, endLine: 3 })).toBe(
      true
    )
    expect(areLineRangesEqual({ startLine: 1, endLine: 3 }, { startLine: 1, endLine: 4 })).toBe(
      false
    )
  })

  it('treats null as a value', () => {
    expect(areLineRangesEqual(null, null)).toBe(true)
    expect(areLineRangesEqual(null, { startLine: 1, endLine: 1 })).toBe(false)
  })
})
