import { describe, expect, it, vi } from 'vitest'
import {
  settleCancelled,
  SubagentContractError,
  waitForQuiescence,
  type CancellableAgent,
  type QuiescentAgent,
  type SubagentLifecycle,
} from '../src/lifecycle.js'

/** A root agent whose session seq a test advances to simulate new rounds. */
interface FakeAgent {
  status: QuiescentAgent['status']
  session: { seq: number }
  whenIdle: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function fakeAgent(): FakeAgent {
  return { status: 'idle', session: { seq: 0 }, whenIdle: vi.fn(() => Promise.resolve()) }
}

/** View the mutable fake through the loop's read-only contract. */
function view(agent: FakeAgent): QuiescentAgent {
  return agent as unknown as QuiescentAgent
}

function lifecycle(waitForChildren: NonNullable<SubagentLifecycle['waitForChildren']>): SubagentLifecycle {
  return { waitForChildren, drainDescendants: vi.fn(() => Promise.resolve()) }
}

describe('waitForQuiescence', () => {
  it('returns after one idle check when the profile mounts no subagents', async () => {
    const agent = fakeAgent()
    await expect(waitForQuiescence(undefined, view(agent), new AbortController().signal)).resolves.toBe('settled')
    expect(agent.whenIdle).toHaveBeenCalledTimes(1)
  })

  it('keeps waiting while settled children wake the parent for more rounds', async () => {
    const agent = fakeAgent()
    // Two children settle in turn; each wakes the parent, which appends events.
    let pending = 2
    const subagents = lifecycle(vi.fn(() => {
      if (pending === 0) return Promise.resolve(false)
      pending -= 1
      agent.session.seq += 1
      return Promise.resolve(true)
    }))

    await waitForQuiescence(subagents, view(agent), new AbortController().signal)

    expect(subagents.waitForChildren).toHaveBeenCalledTimes(3)
    expect(agent.whenIdle).toHaveBeenCalledTimes(3)
  })

  it('loops again when the parent woke between idle and the child check', async () => {
    const agent = fakeAgent()
    let raced = false
    const subagents = lifecycle(vi.fn(() => {
      if (!raced) {
        // A child settled and its notification already appended to the parent.
        raced = true
        agent.session.seq += 1
      }
      return Promise.resolve(false)
    }))

    await waitForQuiescence(subagents, view(agent), new AbortController().signal)

    expect(agent.whenIdle).toHaveBeenCalledTimes(2)
  })

  it('joins subagent tree work through the 0.2.2 waitForTreeWork name', async () => {
    const agent = fakeAgent()
    // Two children settle in turn; each wakes the parent, which appends events.
    let pending = 2
    const treeWork = vi.fn<() => Promise<boolean>>(() => {
      if (pending === 0) return Promise.resolve(false)
      pending -= 1
      agent.session.seq += 1
      return Promise.resolve(true)
    })
    const subagents: SubagentLifecycle = {
      waitForTreeWork: treeWork,
      drainDescendants: vi.fn(() => Promise.resolve()),
    }

    await expect(waitForQuiescence(subagents, view(agent), new AbortController().signal)).resolves.toBe('settled')

    expect(treeWork).toHaveBeenCalledTimes(3)
    expect(agent.whenIdle).toHaveBeenCalledTimes(3)
  })

  it('does not report settled while an asynchronous tree wait is still running', async () => {
    const agent = fakeAgent()
    let markEntered!: () => void
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered })
    let finishChild!: (value: boolean) => void
    const childWait = new Promise<boolean>((resolveChild) => { finishChild = resolveChild })
    let calls = 0
    const treeWork = vi.fn<() => Promise<boolean>>(() => {
      calls += 1
      if (calls > 1) return Promise.resolve(false)
      markEntered()
      return childWait
    })
    const subagents: SubagentLifecycle = {
      waitForTreeWork: treeWork,
      drainDescendants: vi.fn(() => Promise.resolve()),
    }
    let settled = false
    const run = waitForQuiescence(subagents, view(agent), new AbortController().signal).then((value) => {
      settled = true
      return value
    })

    await entered
    expect(settled).toBe(false)
    finishChild(true)

    await expect(run).resolves.toBe('settled')
    expect(treeWork).toHaveBeenCalledTimes(2)
    expect(agent.whenIdle).toHaveBeenCalledTimes(2)
  })

  it('propagates an asynchronous tree-wait failure instead of reporting settled', async () => {
    const agent = fakeAgent()
    const failure = new Error('tree wait failed')
    const subagents: SubagentLifecycle = {
      waitForTreeWork: vi.fn(() => Promise.reject(failure)),
      drainDescendants: vi.fn(() => Promise.resolve()),
    }

    await expect(waitForQuiescence(subagents, view(agent), new AbortController().signal)).rejects.toBe(failure)
  })

  it('fails clearly when a mounted service exposes neither child wait', async () => {
    const agent = fakeAgent()
    const subagents: SubagentLifecycle = { drainDescendants: vi.fn(() => Promise.resolve()) }

    // Settling here would emit the result while descendants may still run, so
    // an unknown mounted interface must reject instead of losing that work.
    await expect(waitForQuiescence(subagents, view(agent), new AbortController().signal))
      .rejects.toBeInstanceOf(SubagentContractError)
    await expect(waitForQuiescence(subagents, view(agent), new AbortController().signal))
      .rejects.toThrow(/neither waitForTreeWork .* nor waitForChildren/)
  })

  it('settles after one idle check when the profile mounts no subagents service', async () => {
    const agent = fakeAgent()

    await expect(waitForQuiescence(undefined, view(agent), new AbortController().signal)).resolves.toBe('settled')

    expect(agent.whenIdle).toHaveBeenCalledTimes(1)
  })

  it('stops waiting on children once the task is cancelled', async () => {
    const agent = fakeAgent()
    const cancel = new AbortController()
    // A child that never settles on its own.
    const subagents = lifecycle(vi.fn(() => new Promise<boolean>(() => {})))

    const done = waitForQuiescence(subagents, view(agent), cancel.signal)
    cancel.abort()

    await expect(done).resolves.toBe('cancelled')
  })

  it('does not join a round a late child wakes after cancellation', async () => {
    const agent = fakeAgent()
    const cancel = new AbortController()
    let markEntered!: () => void
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered })
    let settleChildren!: (value: boolean) => void
    const childWait = new Promise<boolean>((resolveChildren) => { settleChildren = resolveChildren })
    const subagents = lifecycle(vi.fn(() => {
      markEntered()
      return childWait
    }))

    const done = waitForQuiescence(subagents, view(agent), cancel.signal)
    await entered
    const idleCallsBeforeCancel = agent.whenIdle.mock.calls.length
    // The late child wakes the parent: from here on whenIdle() would follow the new round.
    agent.status = 'running'
    agent.whenIdle.mockImplementation(() => new Promise<void>(() => {}))
    cancel.abort()
    settleChildren(true)

    await expect(done).resolves.toBe('cancelled')
    expect(agent.whenIdle).toHaveBeenCalledTimes(idleCallsBeforeCancel)
  })
})

describe('settleCancelled', () => {
  function cancellable(): FakeAgent & { cancel: ReturnType<typeof vi.fn> } {
    return { ...fakeAgent(), cancel: vi.fn() }
  }

  it('drains descendants before the final cancel so no child can wake the root again', async () => {
    const agent = cancellable()
    const order: string[] = []
    agent.cancel.mockImplementation(() => { order.push('cancel') })
    agent.whenIdle.mockImplementation(() => {
      order.push('idle')
      return Promise.resolve()
    })
    const subagents: SubagentLifecycle = {
      waitForChildren: vi.fn(() => Promise.resolve(false)),
      drainDescendants: vi.fn(() => {
        order.push('drain')
        return Promise.resolve()
      }),
    }

    await settleCancelled(subagents, agent as unknown as CancellableAgent, () => {})

    expect(order).toEqual(['cancel', 'drain', 'cancel', 'idle'])
  })

  it('cancels again until a round that started during the drain is idle', async () => {
    const agent = cancellable()
    // A late child round is running when the drain finishes; one cancel stops it.
    agent.status = 'running'
    agent.whenIdle.mockImplementation(() => Promise.resolve())
    let cancels = 0
    agent.cancel.mockImplementation(() => {
      cancels += 1
      if (cancels === 3) agent.status = 'idle'
    })

    await settleCancelled(undefined, agent as unknown as CancellableAgent, () => {})

    expect(cancels).toBe(3)
    expect(agent.status).toBe('idle')
  })

  it('still converges the root when the drain fails', async () => {
    const agent = cancellable()
    const onDrainError = vi.fn()
    const failure = new Error('drain failed')
    const subagents: SubagentLifecycle = {
      waitForChildren: vi.fn(() => Promise.resolve(false)),
      drainDescendants: vi.fn(() => Promise.reject(failure)),
    }

    await settleCancelled(subagents, agent as unknown as CancellableAgent, onDrainError)

    expect(onDrainError).toHaveBeenCalledWith(failure)
    expect(agent.whenIdle).toHaveBeenCalled()
  })
})
