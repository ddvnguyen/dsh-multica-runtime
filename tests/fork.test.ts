import { describe, expect, it, vi } from 'vitest'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { SEEDED_SUMMARY_HEADER, seededCreateOptions, seededPrompt, startSeeded } from '../src/index.js'
import { parseInboundCommand, PROTOCOL_VERSION } from '../src/protocol.js'
import { SessionForkError } from '@deepseek-ai/dsh-session'

const handle = (id: string): AgentHandle => ({ agent: { session: { id } } } as unknown as AgentHandle)

function executeWith(extra: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    type: 'execute',
    request_id: 'request-1',
    cwd: '/work',
    prompt: 'carry on',
    mcp_servers: [],
    ...extra,
  })
}

describe('parseInboundCommand: seeded start (S3-B2)', () => {
  it('parses fork_parent and seed', () => {
    expect(parseInboundCommand(executeWith({
      fork_parent: 'session-parent',
      seed: 'Summary of the earlier conversation.',
    }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'carry on',
      fork_parent: 'session-parent',
      seed: 'Summary of the earlier conversation.',
      mcp_servers: [],
    })
  })

  it('rejects a fork that also names a session to resume', () => {
    expect(() => parseInboundCommand(executeWith({
      resume_session_id: 'session-parent',
      fork_parent: 'session-parent',
      seed: 'summary',
    }))).toThrow(/mutually exclusive/)
  })

  it('rejects a fork with no seed and a seed with no fork', () => {
    expect(() => parseInboundCommand(executeWith({ fork_parent: 'session-parent' })))
      .toThrow(/requires execute\.seed/)
    expect(() => parseInboundCommand(executeWith({ seed: 'summary' })))
      .toThrow(/requires execute\.fork_parent/)
  })

  it('leaves a plain resume untouched', () => {
    const parsed = parseInboundCommand(executeWith({ resume_session_id: 'session-1' }))
    expect(parsed).toMatchObject({ resume_session_id: 'session-1' })
    expect(parsed).not.toHaveProperty('fork_parent')
    expect(parsed).not.toHaveProperty('seed')
  })
})

describe('seededPrompt', () => {
  it('opens with the parent summary, attributed, then this run\'s request', () => {
    const prompt = seededPrompt({
      forkParent: 'session-parent',
      seed: 'Summary of the earlier conversation.\n\nNew trigger:\n\ncarry on',
      prompt: 'carry on',
    })

    expect(prompt.startsWith(`${SEEDED_SUMMARY_HEADER} (session-parent):\n\n`)).toBe(true)
    expect(prompt).toContain('Summary of the earlier conversation.')
    expect(prompt.endsWith('---\n\ncarry on')).toBe(true)
  })

  it('leaves the request alone when there is no summary text', () => {
    expect(seededPrompt({ forkParent: 'session-parent', seed: '   ', prompt: 'carry on' })).toBe('carry on')
  })
})

describe('seededCreateOptions', () => {
  it('creates a plain child linked to its parent, with no seed events', () => {
    // M-225: seeding the log made the child unreadable, so the summary travels
    // as prompt text and the session starts like any other.
    const options = seededCreateOptions({
      cwd: '/work',
      forkParent: 'session-parent',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: () => undefined,
    })
    expect(String(options.sessionId)).toMatch(/^multica-/)
    expect(String(options.sessionId)).not.toBe('session-parent')
    expect(options.meta).toEqual({
      cwd: '/work',
      parentSession: 'session-parent',
    })
    expect(options.seed).toBeUndefined()
    expect(options.inheritedEventCount).toBeUndefined()
  })
})

describe('startSeeded', () => {
  const input = {
    cwd: '/work',
    forkParent: 'session-parent',
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: () => undefined,
  }

  it('creates the child when dsh accepts it', async () => {
    const create = vi.fn(async (_options: CreateAgentOptions) => handle('session-child'))
    const resumeParent = vi.fn(async () => handle('session-parent'))

    const start = await startSeeded(create, resumeParent, input)

    expect(start.kind).toBe('forked')
    expect(create).toHaveBeenCalledTimes(1)
    expect(resumeParent).not.toHaveBeenCalled()
    expect(create.mock.calls[0][0].meta).toMatchObject({ parentSession: 'session-parent' })
  })

  it('resumes the parent when dsh refuses to create the child', async () => {
    // The named fallback: a refused child must not fail the run.
    const create = vi.fn(async () => {
      throw new SessionForkError('seed event 0 failed validation', 'INVALID_BOUNDARY')
    })
    const resumeParent = vi.fn(async () => handle('session-parent'))

    const start = await startSeeded(create, resumeParent, input)

    expect(start.kind).toBe('resumed')
    if (start.kind !== 'resumed') throw new Error('unreachable')
    expect(start.reason).toContain('seed event 0 failed validation')
    expect(resumeParent).toHaveBeenCalledTimes(1)
    expect(String(start.handle.agent.session.id)).toBe('session-parent')
  })

  it('rethrows a non-seed error instead of resuming', async () => {
    const create = vi.fn(async () => {
      throw new Error('MCP startup failed')
    })
    const resumeParent = vi.fn(async () => handle('session-parent'))

    await expect(startSeeded(create, resumeParent, input)).rejects.toThrow('MCP startup failed')
    expect(resumeParent).not.toHaveBeenCalled()
  })
})
