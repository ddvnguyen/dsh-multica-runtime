/** Error code for a summary whose token estimate exceeds the command's `max_tokens`. */
export const SUMMARY_OVER_CAP_CODE = 'DSH_SUMMARY_OVER_CAP'

/** The bridge's length/4 (UTF-16 code units) summary size estimate, shared by the `summary` frame and the budget check. */
export function summaryTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4)
}

/** True when the summary exceeds `maxTokens`; an absent budget never rejects, and equal is within budget. */
export function summaryOverBudget(text: string, maxTokens: number | undefined): boolean {
  return maxTokens !== undefined && summaryTokenEstimate(text) > maxTokens
}

export function summaryOverCapMessage(text: string, maxTokens: number): string {
  return `${summaryTokenEstimate(text)} tokens exceeds max_tokens ${maxTokens}`
}

/** Capability flags that depend on whether dsh compaction services are present. */
export function summarizeCapabilities(hasCompaction: boolean): { summarize: boolean; summarize_max_tokens: boolean } {
  return { summarize: hasCompaction, summarize_max_tokens: hasCompaction }
}
