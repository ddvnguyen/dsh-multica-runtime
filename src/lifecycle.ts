import type { Agent } from '@deepseek-ai/dsh-agent'

/** The slice of DSH's optional `subagents` service this bridge drives. */
export interface SubagentLifecycle {
  /**
   * DSH 0.2.2+: resolves true when subagent-tree work was joined and the host
   * must recheck the root. Same contract as {@link waitForChildren}, renamed.
   */
  waitForTreeWork?(root: Agent): Promise<boolean>
  /** DSH 0.2.1: resolves true when a child settled and may have woken the parent for another round. */
  waitForChildren?(parent: Agent): Promise<boolean>
  /** Interrupt and settle every managed descendant of the given roots. */
  drainDescendants(parents: readonly Agent[]): Promise<void>
}

/**
 * Join the root's subagent work across the service names the supported DSH
 * range admits.
 *
 * 0.2.2-rc.3 renamed `SubagentRuntime.waitForChildren(parent)` to
 * `waitForTreeWork(root)` and kept the contract: both return true when work was
 * joined so the host rechecks root completion. The name is the only difference,
 * so a pinned name turns the other version into a `TypeError` at this call and
 * fails every run at finalization instead of starting.
 *
 * A profile that mounts no service tracks no child work, so `undefined` is a
 * definite answer. A mounted service exposing neither name is not: settling
 * then would emit the result while descendants still run, silently losing
 * their output, so the wait fails with the contract error instead. That names
 * the release drift for the next reader instead of repeating this bug.
 * @param subagents - DSH's subagent service, absent when the profile mounts none.
 * @param agent - the task's root agent.
 * @returns whether subagent work was joined.
 * @throws {SubagentContractError} when a mounted service has neither known wait.
 */
function joinSubagentWork(subagents: SubagentLifecycle | undefined, agent: Agent): Promise<boolean> {
  if (subagents === undefined) return Promise.resolve(false)
  if (typeof subagents.waitForTreeWork === 'function') return subagents.waitForTreeWork(agent)
  if (typeof subagents.waitForChildren === 'function') return subagents.waitForChildren(agent)
  throw new SubagentContractError(
    'DSH subagents service exposes neither waitForTreeWork (0.2.2+) nor waitForChildren (0.2.1); '
    + 'refusing to report the run settled while descendants may still be running',
  )
}

/** A mounted subagents service does not implement either wait this bridge drives. */
export class SubagentContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubagentContractError'
  }
}

/** The agent surface the quiescence loop reads. */
export type QuiescentAgent = Pick<Agent, 'whenIdle' | 'status'> & { readonly session: Pick<Agent['session'], 'seq'> }

/** The agent surface the cancel path drives. */
export type CancellableAgent = QuiescentAgent & Pick<Agent, 'cancel'>

/**
 * Wait until the root agent and its subagents are quiescent.
 *
 * DSH 0.2 uses an activation model: a finished child notifies the parent,
 * which then runs another round. A single `whenIdle()` would emit the result
 * before those rounds, so loop like DSH's own headless runner and SDK server
 * until the root stays idle across a child check with no new session events.
 *
 * Cancellation returns immediately without waiting on the agent again: a
 * child settling right after the cancel can wake the parent for a fresh round
 * that `whenIdle()` would follow. The caller must then run
 * {@link settleCancelled}, which stops descendants before converging the root.
 * @param subagents - DSH's subagent service, absent when the profile mounts none.
 * @param agent - the task's root agent.
 * @param signal - aborted when Multica cancels the task.
 * @returns `'cancelled'` when the signal aborted, `'settled'` otherwise.
 */
export async function waitForQuiescence(
  subagents: SubagentLifecycle | undefined,
  agent: QuiescentAgent,
  signal: AbortSignal,
): Promise<'settled' | 'cancelled'> {
  const aborted = new Promise<'aborted'>((resolveAborted) => {
    if (signal.aborted) resolveAborted('aborted')
    else signal.addEventListener('abort', () => resolveAborted('aborted'), { once: true })
  })
  while (true) {
    if (await Promise.race([agent.whenIdle(), aborted]) === 'aborted') return 'cancelled'
    const idleSeq = agent.session.seq
    // Child settlement can wake the parent before the child wait observes it.
    const children = await Promise.race([joinSubagentWork(subagents, agent as Agent), aborted])
    if (children === 'aborted') return 'cancelled'
    if (!children && agent.status === 'idle' && agent.session.seq === idleSeq) return 'settled'
  }
}

/**
 * Converge a cancelled root agent without joining child-woken rounds.
 *
 * Descendants are drained first so no child can deliver another wake-up;
 * then the root is cancelled until it is idle. `cancel()` clears queued work
 * and aborts the active activity, so input a child delivered before the drain
 * is discarded instead of starting a new model round.
 * @param subagents - DSH's subagent service, absent when the profile mounts none.
 * @param agent - the task's root agent.
 * @param onDrainError - reports a drain failure; convergence continues regardless.
 */
export async function settleCancelled(
  subagents: SubagentLifecycle | undefined,
  agent: CancellableAgent,
  onDrainError: (error: unknown) => void,
): Promise<void> {
  agent.cancel({ kind: 'user' })
  try {
    await subagents?.drainDescendants([agent as Agent])
  } catch (error: unknown) {
    onDrainError(error)
  }
  do {
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
  } while (agent.status !== 'idle')
}
