import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { seededCreateOptions } from '../src/index.js'
import { readV4 } from './helpers/v4-reader.mjs'

/**
 * Read-back test for a summary-seeded child (M-225, found on lane z by M-177).
 *
 * dsh's released v4 reader protects the first surface node for the system
 * prompt: `system/message` is only admitted while the surface is still empty,
 * so a log whose first surface is a synthetic user message can never be read
 * back — neither summarized nor resumed. The bridge used to seed the child with
 * exactly that message.
 *
 * The log below is one completed step, in the shape dsh writes it (field set
 * and ordering taken from a session captured on lane z under dsh 0.2.2-alpha.2).
 * `restoreReleasedV4Artifact` is the reader dsh itself restores through, so a
 * log it accepts is a log the next summarize/resume can load.
 */
interface V4Event {
  type: string
  seq: number
  time: number
  surfaceOp?: string
  data: Record<string, unknown>
}

const text = (value: string): Array<Record<string, unknown>> => [{ type: 'text', text: value }]

/** The header dsh writes for a plain child session. */
const header = {
  version: 4,
  id: 'multica-child',
  createdAt: 1_700_000_000_000,
  isSeeded: false,
  delegationDepth: 0,
  cwd: '/work',
}

/** One completed step: system prompt, this run's prompt, one assistant reply. */
function stepLog(prompt: string): V4Event[] {
  return [
    { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, time: 1, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, time: 1, data: { policy: 'ask' } },
    { type: 'turn/start', seq: 3, time: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 4, time: 1, data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      seq: 5,
      time: 1,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'system', id: 'sys-1', source: { kind: 'system-prompt' }, content: text('You are a test agent.') },
      },
    },
    {
      type: 'user/message',
      seq: 6,
      time: 1,
      surfaceOp: 'append',
      data: { id: 'msg-1', role: 'user', source: { kind: 'user' }, content: text(prompt) },
    },
    {
      type: 'assistant/message',
      seq: 7,
      time: 1,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', id: 'asst-1', source: { kind: 'model' }, content: text('hi') },
      },
    },
    { type: 'step/end', seq: 8, time: 1, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 9, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** The seed event shape the bridge used to hand dsh: a user message at seq 0. */
function leadingUserMessage(prompt: string): V4Event {
  return {
    type: 'user/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: { id: 'seed-1', role: 'user', source: { kind: 'user' }, content: text(prompt) },
  }
}

function read(events: V4Event[], seeded = false) {
  return readV4(
    {
      header: seeded ? { ...header, isSeeded: true } : header,
      events,
      inheritedEventCount: seeded ? 1 : 0,
    },
    KNOWN_SESSION_EVENT_TYPES,
  )
}

describe('seeded child read-back', () => {
  it('reads a step log with no seed events, which is what the bridge asks dsh to write', async () => {
    const options = seededCreateOptions({
      cwd: '/work',
      forkParent: 'multica-parent',
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: () => undefined,
    })

    // The regression guard: a seed event here is what made the child unreadable.
    expect(options.seed).toBeUndefined()
    expect(options.inheritedEventCount).toBeUndefined()

    await expect(read(stepLog('hello'), false)).resolves.toBeDefined()
  })

  it('rejects a log whose first surface is a synthetic user message', async () => {
    // dsh appends its inherited marker right after a seed, then the step runs.
    const seededLog = [leadingUserMessage('summary'), ...stepLog('hello').map(event => ({ ...event, seq: event.seq + 2 }))]
    seededLog.splice(1, 0, { type: 'session/end-seed', seq: 1, time: 1, data: { inherited: true } })

    await expect(read(seededLog, true)).rejects.toThrow(/system\/message requires a protected first surface head/)
  })
})
