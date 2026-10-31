import { describe, expect, it } from 'vitest'
import {
  summarizeCapabilities,
  summaryOverBudget,
  summaryOverCapMessage,
  summaryTokenEstimate,
} from '../src/summary-budget.js'

describe('summary budget', () => {
  it('estimates tokens as ceil(length / 4)', () => {
    expect(summaryTokenEstimate('')).toBe(0)
    expect(summaryTokenEstimate('abcd')).toBe(1)
    expect(summaryTokenEstimate('abcde')).toBe(2)
  })

  it('is never over budget without max_tokens', () => {
    expect(summaryOverBudget('x'.repeat(100000), undefined)).toBe(false)
  })

  it('treats a summary equal to max_tokens as within budget', () => {
    expect(summaryOverBudget('x'.repeat(40), 10)).toBe(false)
    expect(summaryOverBudget('x'.repeat(39), 10)).toBe(false)
  })

  it('is over budget when the estimate exceeds max_tokens', () => {
    expect(summaryOverBudget('x'.repeat(41), 10)).toBe(true)
    expect(summaryOverBudget('x'.repeat(8), 1)).toBe(true)
  })

  it('formats the over-cap message with estimate and cap', () => {
    expect(summaryOverCapMessage('x'.repeat(41), 10)).toBe('11 tokens exceeds max_tokens 10')
  })

  it('advertises summarize_max_tokens exactly when summarize is advertised', () => {
    expect(summarizeCapabilities(true)).toEqual({ summarize: true, summarize_max_tokens: true })
    expect(summarizeCapabilities(false)).toEqual({ summarize: false, summarize_max_tokens: false })
  })
})
