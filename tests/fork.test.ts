import { describe, expect, it, vi } from 'vitest'
import type { AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { buildSummarySeed, seededCreateOptions, startSeeded } from '../src/index.js'
import { parseInboundCommand, PROTOCOL_VERSION } from '../src/protocol.js'

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

describe('buildSummarySeed', () => {
  it('seeds one inherited user message at seq 0', () => {
    const seed = buildSummarySeed('Summary of the earlier conversation.\n\nNew trigger:\n\ncarry on', 1_700_000_000_000)
    expect(seed).toHaveLength(1)
    const [event] = seed
    expect(event).toMatchObject({
      type: 'user/message',
      seq: 0,
      time: 1_700_000_000_000,
      surfaceOp: 'append',
    })
    if (event.type !== 'user/message') throw new Error(`seed event is ${event.type}`)
    expect(event.data.content).toEqual([{
      type: 'text',
      text: 'Summary of the earlier conversation.\n\nNew trigger:\n\ncarry on',
    }])
  })
})

describe('seededCreateOptions', () => {
  it('links the child to its parent and marks it seeded', () => {
    const options = seededCreateOptions({
      cwd: '/work',
      forkParent: 'session-parent',
      seed: 'summary',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: () => undefined,
      now: 1_700_000_000_000,
    })
    expect(String(options.sessionId)).toMatch(/^multica-/)
    expect(String(options.sessionId)).not.toBe('session-parent')
    expect(options.meta).toEqual({
      cwd: '/work',
      parentSession: 'session-parent',
      isSeeded: true,
    })
    expect(options.inheritedEventCount).toBe(1)
    expect(options.seed).toHaveLength(1)
  })
})

describe('startSeeded', () => {
  const input = {
    cwd: '/work',
    forkParent: 'session-parent',
    seed: 'summary',
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    setup: () => undefined,
  }

  it('forks when dsh accepts the seed', async () => {
    const create = vi.fn(async (_options: CreateAgentOptions) => handle('session-child'))
    const resumeParent = vi.fn(async () => handle('session-parent'))

    const start = await startSeeded(create, resumeParent, input)

    expect(start.kind).toBe('forked')
    expect(create).toHaveBeenCalledTimes(1)
    expect(resumeParent).not.toHaveBeenCalled()
    expect(create.mock.calls[0][0].meta).toMatchObject({ parentSession: 'session-parent', isSeeded: true })
  })

  it('resumes the parent when dsh rejects the seed', async () => {
    // The named fallback: a seed dsh cannot validate must not fail the run.
    const create = vi.fn(async () => {
      throw new Error('seed event 0 failed validation')
    })
    const resumeParent = vi.fn(async () => handle('session-parent'))

    const start = await startSeeded(create, resumeParent, input)

    expect(start.kind).toBe('resumed')
    if (start.kind !== 'resumed') throw new Error('unreachable')
    expect(start.reason).toContain('seed event 0 failed validation')
    expect(resumeParent).toHaveBeenCalledTimes(1)
    expect(String(start.handle.agent.session.id)).toBe('session-parent')
  })
})
