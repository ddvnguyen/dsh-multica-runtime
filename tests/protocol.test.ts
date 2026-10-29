import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  normalizeMcpServerName,
  parseInboundCommand,
  PROTOCOL_VERSION,
  truncateUtf8,
} from '../src/protocol.js'
import { multicaTerminalEnvironment } from '../src/task-env.js'

describe('Multica terminal environment', () => {
  it('forwards only a task-scoped Multica token', () => {
    expect(multicaTerminalEnvironment({
      MULTICA_TOKEN: 'mat_task-token',
      DEEPSEEK_API_KEY: 'provider-secret',
      OTHER_TOKEN: 'other-secret',
    })).toEqual({ MULTICA_TOKEN: 'mat_task-token' })
  })

  it('does not forward a user PAT or arbitrary credentials', () => {
    expect(multicaTerminalEnvironment({
      MULTICA_TOKEN: 'mul_user-token',
      DEEPSEEK_API_KEY: 'provider-secret',
    })).toEqual({})
  })
})

describe('parseInboundCommand', () => {
  it('parses an execute command with model and MCP servers', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'run tests',
      model: { provider: 'deepseek-official', id: 'deepseek-v4-flash', reasoning_effort: 'high' },
      reasoning_effort: 'max',
      mcp_servers: [{
        name: 'filesystem',
        transport: 'stdio',
        command: 'mcp-filesystem',
        args: ['/work'],
        env: { MODE: 'read-write' },
      }],
    }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'run tests',
      model: { provider: 'deepseek-official', id: 'deepseek-v4-flash', reasoning_effort: 'high' },
      reasoning_effort: 'max',
      mcp_servers: [{
        name: 'filesystem',
        transport: 'stdio',
        command: 'mcp-filesystem',
        args: ['/work'],
        env: { MODE: 'read-write' },
      }],
    })
  })

  it('defaults the MCP list and rejects unknown fields', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'hello',
    }))).toMatchObject({ mcp_servers: [] })

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'cancel',
      request_id: 'request-1',
      secret: true,
    }))).toThrow('unsupported field')
  })

  it('rejects unsupported transports and protocol versions', () => {
    expect(() => parseInboundCommand(JSON.stringify({
      v: 2,
      type: 'cancel',
      request_id: 'request-1',
    }))).toThrow('unsupported protocol version')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'hello',
      mcp_servers: [{ name: 'legacy', transport: 'sse', url: 'https://example.test/sse' }],
    }))).toThrow('stdio or streamable-http')
  })

  it('parses an answer command and rejects malformed answers', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'answer',
      request_id: 'request-1',
      call_id: 'q-1',
      answers: [
        { id: 'plan', selected: ['Approve'] },
        { id: 'mode', selected: [], custom: 'use staging' },
      ],
    }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'answer',
      request_id: 'request-1',
      call_id: 'q-1',
      answers: [
        { id: 'plan', selected: ['Approve'] },
        { id: 'mode', selected: [], custom: 'use staging' },
      ],
    })

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'answer',
      request_id: 'request-1',
      call_id: 'q-1',
    }))).toThrow('must be an array')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'answer',
      request_id: 'request-1',
      call_id: 'q-1',
      answers: [],
      stale: true,
    }))).toThrow('unsupported field')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'answer',
      request_id: 'request-1',
      call_id: 'q-1',
      answers: [{ id: 'plan', selected: 'Approve' }],
    }))).toThrow('array of strings')
  })

  it('parses steer and queue commands with a required message', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'steer',
      request_id: 'request-1',
      message: 'use the staged branch',
    }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'steer',
      request_id: 'request-1',
      message: 'use the staged branch',
    })

    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'queue',
      request_id: 'request-1',
      message: 'then run pnpm check',
    }))).toEqual({
      v: PROTOCOL_VERSION,
      type: 'queue',
      request_id: 'request-1',
      message: 'then run pnpm check',
    })
  })

  it('rejects malformed steer and queue commands', () => {
    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'steer',
      request_id: 'request-1',
    }))).toThrow('steer.message must be a non-empty string')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'queue',
      request_id: 'request-1',
      message: 42,
    }))).toThrow('queue.message must be a non-empty string')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'steer',
      request_id: 'request-1',
      message: 'hi',
      extra: true,
    }))).toThrow('steer command contains unsupported field: extra')
  })
})

describe('wire helpers', () => {
  it('normalizes MCP names deterministically', () => {
    expect(normalizeMcpServerName('already_valid')).toBe('already_valid')
    expect(normalizeMcpServerName('My GitHub MCP!')).toMatch(/^My_GitHub_MCP_[0-9a-f]{8}$/)
    expect(normalizeMcpServerName('My GitHub MCP!')).toBe(normalizeMcpServerName('My GitHub MCP!'))
  })

  it('truncates output on a UTF-8 boundary', () => {
    const result = truncateUtf8('你好世界', 7)
    expect(result.truncated).toBe(true)
    expect(result.value).toBe('你好\n[output truncated]')
  })

  it('encodes exactly one JSON line', () => {
    const line = encodeFrame({
      v: 1,
      type: 'protocol_error',
      code: 'BAD_INPUT',
      message: 'bad input',
    })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
  })
})

describe('summarize command (S3-B1)', () => {
  it('parses a summarize first command with an optional model', () => {
    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'summarize',
      request_id: 'task-1',
      session_id: 'session-1',
    }))).toEqual({
      v: 1,
      type: 'summarize',
      request_id: 'task-1',
      session_id: 'session-1',
    })

    expect(parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'summarize',
      request_id: 'task-1',
      session_id: 'session-1',
      model: { provider: 'deepseek', id: 'v4-pro' },
    }))).toMatchObject({ model: { provider: 'deepseek', id: 'v4-pro' } })
  })

  it('requires the session id and rejects execute-shaped extras', () => {
    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'summarize',
      request_id: 'task-1',
    }))).toThrow('summarize.session_id')

    expect(() => parseInboundCommand(JSON.stringify({
      v: 1,
      type: 'summarize',
      request_id: 'task-1',
      session_id: 'session-1',
      prompt: 'sneaky',
    }))).toThrow('unsupported field')
  })

  it('encodes a summary frame as one JSON line with the token estimate field', () => {
    const line = encodeFrame({
      v: 1,
      type: 'summary',
      request_id: 'task-1',
      session_id: 'session-1',
      summary: 'The session did X.',
      summary_tokens: 5,
    })
    expect(JSON.parse(line)).toMatchObject({
      type: 'summary',
      session_id: 'session-1',
      summary: 'The session did X.',
      summary_tokens: 5,
    })
  })
})
