import { describe, expect, it, vi } from 'vitest'
import { dispatchInbound, inboxBoundaryFrames, type InboxAgent, type RunRef } from '../src/index.js'
import { PROTOCOL_VERSION, type QueueCommand, type SteerCommand } from '../src/protocol.js'

function steerCommand(request_id = 'req-1'): SteerCommand {
  return { v: PROTOCOL_VERSION, type: 'steer', request_id, message: 'take the left path' }
}

function queueCommand(request_id = 'req-1'): QueueCommand {
  return { v: PROTOCOL_VERSION, type: 'queue', request_id, message: 'then run pnpm check' }
}

/** A fake agent that records what reached its inbox. */
function makeAgent(seq = 10) {
  const steer = vi.fn()
  const followup = vi.fn()
  return { agent: { session: { seq }, steer, followup }, steer, followup }
}

function makeRun(agent?: InboxAgent, overrides: Partial<RunRef> = {}): RunRef {
  return { requestId: 'req-1', finished: false, agent, inbox: { pending: [] }, ...overrides }
}

describe('dispatchInbound', () => {
  it('delivers a steer to the inbox and answers with accepted', () => {
    const { agent, steer, followup } = makeAgent(12)
    const run = makeRun(agent)
    const outcome = dispatchInbound(run, steerCommand())

    expect(outcome).toEqual({
      kind: 'deliver',
      frame: { v: 1, type: 'inbox_state', request_id: 'req-1', command: 'steer', state: 'accepted' },
    })
    expect(followup).not.toHaveBeenCalled()
    expect(steer.mock.calls[0][0].content[0]).toEqual({ type: 'text', text: 'take the left path' })
    expect(run.inbox.pending).toHaveLength(1)
    expect(run.inbox.pending[0]).toMatchObject({ command: 'steer', acceptedSeq: 12 })
  })

  it('delivers a queue as the agent follow-up that becomes the next turn', () => {
    const { agent, steer, followup } = makeAgent(4)
    const run = makeRun(agent)
    const outcome = dispatchInbound(run, queueCommand())

    expect(outcome).toMatchObject({ kind: 'deliver', frame: { command: 'queue', state: 'accepted' } })
    expect(steer).not.toHaveBeenCalled()
    expect(followup.mock.calls[0][0].content[0]).toEqual({ type: 'text', text: 'then run pnpm check' })
    expect(run.inbox.pending).toMatchObject([{ command: 'queue', acceptedSeq: 4 }])
  })

  it('rejects when the run, its agent, or its request id cannot take the message', () => {
    const { agent, steer, followup } = makeAgent()
    const { agent: finishedAgent } = makeAgent()

    expect(dispatchInbound(undefined, steerCommand())).toMatchObject({
      kind: 'reject',
      frame: { state: 'rejected', reason: 'agent_not_ready' },
    })
    expect(dispatchInbound(makeRun(undefined), steerCommand())).toMatchObject({
      kind: 'reject',
      frame: { state: 'rejected', reason: 'agent_not_ready' },
    })
    expect(dispatchInbound(makeRun(finishedAgent, { finished: true }), queueCommand())).toMatchObject({
      kind: 'reject',
      frame: { state: 'rejected', reason: 'run_finished' },
    })

    const foreign = dispatchInbound(makeRun(agent), steerCommand('other-request'))
    expect(foreign).toMatchObject({
      kind: 'reject',
      frame: { request_id: 'other-request', state: 'rejected', reason: 'unknown_request_id' },
    })
    expect(steer).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })

  it('reports a failed delivery and forgets the pending message', () => {
    const { agent, steer } = makeAgent()
    steer.mockImplementation(() => { throw new Error('inbox closed') })
    const run = makeRun(agent)

    expect(dispatchInbound(run, steerCommand())).toMatchObject({
      kind: 'reject',
      frame: { state: 'rejected', reason: 'inbox closed' },
    })
    expect(run.inbox.pending).toHaveLength(0)
  })

  it('lets only a cancel naming this live run act on it', () => {
    const { agent } = makeAgent()
    const run = makeRun(agent)

    expect(dispatchInbound(run, { v: PROTOCOL_VERSION, type: 'cancel', request_id: 'other-request' })).toEqual({ kind: 'drop' })
    expect(dispatchInbound(run, { v: PROTOCOL_VERSION, type: 'cancel', request_id: 'req-1' })).toEqual({ kind: 'act' })
    expect(dispatchInbound({ ...run, finished: true }, { v: PROTOCOL_VERSION, type: 'cancel', request_id: 'req-1' })).toEqual({ kind: 'drop' })
  })

  it('lets only an answer naming this run act on it', () => {
    const { agent } = makeAgent()
    const run = makeRun(agent)
    const answer = { v: PROTOCOL_VERSION, type: 'answer' as const, request_id: 'req-1', call_id: 'q-1', answers: [] }

    expect(dispatchInbound(run, answer)).toEqual({ kind: 'act' })
    expect(dispatchInbound(run, { ...answer, request_id: 'other-request' })).toEqual({ kind: 'drop' })
  })
})

describe('inboxBoundaryFrames', () => {
  it('applies a steer at the next step boundary and clears it', () => {
    const { agent } = makeAgent(7)
    const run = makeRun(agent)
    dispatchInbound(run, steerCommand())

    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'step/start', 8)).toEqual([
      { v: 1, type: 'inbox_state', request_id: 'req-1', command: 'steer', state: 'applied' },
    ])
    expect(run.inbox.pending).toHaveLength(0)
  })

  it('waits for the queued message own turn, skipping the initial prompt turn', () => {
    const { agent } = makeAgent(5)
    const run = makeRun(agent)
    dispatchInbound(run, queueCommand())

    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'turn/start', 6)).toEqual([])
    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'turn/start', 9)).toEqual([
      { v: 1, type: 'inbox_state', request_id: 'req-1', command: 'queue', state: 'applied' },
    ])
    expect(run.inbox.pending).toHaveLength(0)
  })

  it('does not apply a queue at a step boundary, nor a steer at a turn boundary', () => {
    const { agent } = makeAgent(3)
    const run = makeRun(agent)
    dispatchInbound(run, queueCommand())
    dispatchInbound(run, steerCommand())

    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'step/start', 9)).toEqual([
      { v: 1, type: 'inbox_state', request_id: 'req-1', command: 'steer', state: 'applied' },
    ])
    // First observed turn still belongs to the prompt, so the queue waits.
    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'turn/start', 10)).toEqual([])
    expect(run.inbox.pending).toMatchObject([{ command: 'queue' }])
  })

  it('ignores boundaries at or below the acceptance seq and unrelated events', () => {
    const { agent } = makeAgent(10)
    const run = makeRun(agent)
    dispatchInbound(run, steerCommand())

    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'step/start', 10)).toEqual([])
    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'assistant/message', 11)).toEqual([])
    expect(inboxBoundaryFrames(run.inbox, 'req-1', 'turn/end', 12)).toEqual([])
    expect(run.inbox.pending).toHaveLength(1)
  })
})
