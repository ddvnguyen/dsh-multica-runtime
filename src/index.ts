import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { Context } from '@deepseek-ai/cordis'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type AgentRegistry,
  type AgentSetup,
  type CreateAgentOptions,
  type ModelSelection,
  type ModelSelectionRef,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage, ReasoningEffortId, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import {
  SessionId,
  SessionForkError,
  SessionLogOffset,
  SessionSeq,
  type SessionEvent,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import {
  encodeFrame,
  normalizeMcpServerName,
  parseInboundCommand,
  PROTOCOL_VERSION,
  truncateUtf8,
  type AnswerCommand,
  type ExecuteCommand,
  type FirstCommand,
  type InboxStateFrame,
  type McpServerInput,
  type OutboundFrame,
  type PostExecuteCommand,
  type QueueCommand,
  type RuntimeAnswerItem,
  type RuntimeModelFrame,
  type RuntimeQuestion,
  type RuntimeQuestionIntent,
  type SteerCommand,
  type SummarizeCommand,
} from './protocol.js'
import { installMulticaTerminalEnvironment } from './environment.js'
import { settleCancelled as settleCancelledAgent, waitForQuiescence, type SubagentLifecycle } from './lifecycle.js'

export const name = 'multica-dsh-runtime'
export const inject = ['cmdlineArgs', 'agents', 'agentDefaultModel', 'sessions', 'llm']

const PLUGIN_VERSION = '0.2.0-private.3'

interface ActiveRun {
  command: ExecuteCommand
  agent?: Agent
  firstSeq: number
  cancelRequested: boolean
  teardown: boolean
  /** Aborted on cancel so a pending subagent wait cannot hold the result frame. */
  cancel: AbortController
  lastText: string
  endReason?: TurnEndReason
  toolNames: Map<string, string>
  /**
   * The one ask this run is parked on, if any. The `user-questions/request`
   * answerer sets it after emitting the `question` frame; the stdin handler
   * settles it from the daemon's `answer` command, and cancel rejects it.
   */
  pendingQuestion?: { callId: string; resolve: (answers: RuntimeAnswerItem[]) => void; reject: (error: Error) => void }
  /** Deliveries waiting for their boundary event, so accepted/applied frames pair up. */
  inbox: InboxTracker
}

class ResumeRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ResumeRejectedError'
  }
}

/**
 * Structural view of one question of a user-questions request. dsh's
 * AskUserQuestionItem satisfies it, and the mapping copies declared fields
 * only, so a field a future dsh adds never reaches the wire by accident.
 */
export interface WireQuestionInput {
  id: string
  question: string
  detail?: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
  intent?: RuntimeQuestionIntent
}

/** Maps request questions onto the `question` frame's wire shape. */
export function mapQuestionsForWire(questions: readonly WireQuestionInput[]): RuntimeQuestion[] {
  return questions.map(question => ({
    id: question.id,
    question: question.question,
    ...question.detail === undefined ? {} : { detail: question.detail },
    ...question.header === undefined ? {} : { header: question.header },
    ...question.options === undefined
      ? {}
      : {
          options: question.options.map(option => ({
            label: option.label,
            ...option.description === undefined ? {} : { description: option.description },
          })),
        },
    ...question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect },
    ...question.intent === undefined ? {} : { intent: question.intent },
  }))
}

/**
 * Settles the run's parked ask from an inbound `answer` command. Returns
 * false when the call id matches no open question — a stale or duplicate
 * answer is ignored rather than failing the run.
 */
export function settlePendingQuestion(
  pending: { callId: string; resolve: (answers: RuntimeAnswerItem[]) => void } | undefined,
  command: Pick<AnswerCommand, 'call_id' | 'answers'>,
): boolean {
  if (pending === undefined || pending.callId !== command.call_id) return false
  pending.resolve(command.answers)
  return true
}

/** The agent surface an inbound `steer`/`queue` needs to reach the inbox. */
export interface InboxAgent {
  readonly session: { readonly seq: number }
  steer(message: UserMessage): void
  followup(message: UserMessage): void
}

/** One delivered message waiting for the boundary event that applies it. */
export interface PendingInboxEntry {
  command: 'steer' | 'queue'
  message: UserMessage
  /** Agent seq at delivery: a boundary at or below it is not this message's. */
  acceptedSeq: number
}

/** A run's inbox deliveries, tracked so the accepted/applied frames pair up. */
export interface InboxTracker {
  pending: PendingInboxEntry[]
  /**
   * Seq of the first observed `turn/start` — the run's initial prompt turn.
   * A queue accepted before it waits for the following turn: a queued message
   * becomes the sole message of its own turn, never the prompt's.
   */
  promptTurnSeq?: number
}

/** The slice of a run one post-execute command is checked against. */
export interface RunRef {
  requestId: string
  finished: boolean
  cancelRequested?: boolean
  teardown?: boolean
  agent?: InboxAgent
  inbox: InboxTracker
}

/**
 * What one command that followed `execute` may do:
 * `deliver`/`reject` answer a `steer`/`queue` with its `inbox_state` frame,
 * `act` lets an `answer`/`cancel` that names this run proceed, and `drop`
 * keeps a foreign or stale command away from the agent.
 */
export type InboundOutcome =
  | { kind: 'deliver'; frame: InboxStateFrame }
  | { kind: 'reject'; frame: InboxStateFrame }
  | { kind: 'act' }
  | { kind: 'drop' }

function rejectedInboxFrame(command: SteerCommand | QueueCommand, reason: string): InboundOutcome {
  return {
    kind: 'reject',
    frame: { v: PROTOCOL_VERSION, type: 'inbox_state', request_id: command.request_id, command: command.type, state: 'rejected', reason },
  }
}

/**
 * Route one command that followed `execute` against the run it addresses.
 *
 * A `steer`/`queue` is delivered only when it names this run, the run is
 * alive and its agent exists; the delivered message is pushed onto the run's
 * tracker *before* the agent call so a boundary event observed during the
 * call cannot go unpaired. `drop` is the per-session cancel gate: one DSH
 * process handles exactly one `execute` and one session, so a cancel naming
 * any other request never reaches the agent.
 */
export function dispatchInbound(run: RunRef | undefined, command: PostExecuteCommand): InboundOutcome {
  if (command.type === 'steer' || command.type === 'queue') {
    if (run === undefined) return rejectedInboxFrame(command, 'agent_not_ready')
    if (command.request_id !== run.requestId) return rejectedInboxFrame(command, 'unknown_request_id')
    if (run.finished || run.cancelRequested === true || run.teardown === true) return rejectedInboxFrame(command, 'run_finished')
    if (run.agent === undefined) return rejectedInboxFrame(command, 'agent_not_ready')
    const message = createUserMessage({ content: [{ type: 'text', text: command.message }], source: { kind: 'user' } })
    const pending: PendingInboxEntry = { command: command.type, message, acceptedSeq: run.agent.session.seq }
    run.inbox.pending.push(pending)
    try {
      if (command.type === 'steer') run.agent.steer(message)
      else run.agent.followup(message)
    } catch (error: unknown) {
      run.inbox.pending = run.inbox.pending.filter(entry => entry !== pending)
      return rejectedInboxFrame(command, errorMessage(error))
    }
    return {
      kind: 'deliver',
      frame: { v: PROTOCOL_VERSION, type: 'inbox_state', request_id: command.request_id, command: command.type, state: 'accepted' },
    }
  }
  if (run === undefined || command.request_id !== run.requestId || run.finished) return { kind: 'drop' }
  return { kind: 'act' }
}

function drainApplied(tracker: InboxTracker, requestId: string, command: 'steer' | 'queue', seq: number): InboxStateFrame[] {
  const applied: InboxStateFrame[] = []
  tracker.pending = tracker.pending.filter((entry) => {
    if (entry.command !== command || entry.acceptedSeq >= seq) return true
    applied.push({ v: PROTOCOL_VERSION, type: 'inbox_state', request_id: requestId, command, state: 'applied' })
    return false
  })
  return applied
}

/**
 * The `applied` frames for one run-boundary session event: a `step/start`
 * applies every steer delivered before it (dsh consumes steering at its next
 * step boundary), a `turn/start` applies queued followups — except the run's
 * first observed turn, which belongs to the initial prompt. Any other event
 * applies nothing.
 */
export function inboxBoundaryFrames(tracker: InboxTracker, requestId: string, type: string, seq: number): InboxStateFrame[] {
  if (type === 'turn/start') {
    if (tracker.promptTurnSeq === undefined) {
      tracker.promptTurnSeq = seq
      return []
    }
    return drainApplied(tracker, requestId, 'queue', seq)
  }
  if (type === 'step/start') return drainApplied(tracker, requestId, 'steer', seq)
  return []
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeFrame(frame: OutboundFrame): void {
  process.stdout.write(encodeFrame(frame))
}

function writeDiagnostic(message: string): void {
  process.stderr.write(`multica-dsh-runtime: ${message}\n`)
}

function protocolError(code: string, message: string): void {
  writeFrame({ v: PROTOCOL_VERSION, type: 'protocol_error', code, message })
}

function parseMode(args: readonly string[]): 'stdio' | 'probe' | 'list-models' {
  if (args.length !== 1) {
    throw new Error('expected exactly one mode: --stdio, --probe, or --list-models')
  }
  switch (args[0]) {
    case '--stdio': return 'stdio'
    case '--probe': return 'probe'
    case '--list-models': return 'list-models'
    default: throw new Error(`unsupported mode: ${String(args[0])}`)
  }
}

function encodeModelId(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`
}

async function listModels(ctx: Context): Promise<RuntimeModelFrame[]> {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  if (llm === undefined || defaultModel === undefined) throw new Error('DSH model services are unavailable')
  const selected = defaultModel.currentSelection()
  const result: RuntimeModelFrame[] = []
  for (const provider of llm.listProviders()) {
    let models
    try {
      models = await llm.listModels(provider.id)
    } catch (error: unknown) {
      writeDiagnostic(`model discovery failed for ${provider.id}: ${errorMessage(error)}`)
      continue
    }
    for (const model of models) {
      let resolved
      try {
        resolved = await llm.resolveModelInfo(provider.id, model.id)
      } catch (error: unknown) {
        writeDiagnostic(`model capability lookup failed for ${provider.id}/${model.id}: ${errorMessage(error)}`)
      }
      const reasoning = resolved?.reasoning
      result.push({
        id: encodeModelId(provider.id, model.id),
        label: model.name,
        provider: provider.name,
        ...selected.provider === provider.id && selected.model === model.id ? { default: true } : {},
        ...reasoning === undefined
          ? {}
          : {
              thinking: {
                supported_levels: reasoning.efforts.map(effort => ({
                  value: String(effort.id),
                  label: effort.name,
                  ...effort.description === undefined ? {} : { description: effort.description },
                })),
                ...reasoning.defaultEffort === undefined
                  ? {}
                  : { default_level: String(reasoning.defaultEffort) },
              },
            },
      })
    }
  }
  return result.sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label))
}

async function resolveSelection(
  ctx: Context,
  command: Pick<ExecuteCommand, 'model' | 'reasoning_effort'>,
): Promise<ModelSelection> {
  const defaultModel = ctx.get('agentDefaultModel')
  const llm = ctx.get('llm')
  if (defaultModel === undefined || llm === undefined) throw new Error('DSH model services are unavailable')
  const base = command.model === undefined
    ? defaultModel.currentSelection()
    : { provider: command.model.provider, model: command.model.id }
  const info = await llm.resolveModelInfo(base.provider, base.model)
  const effort = command.reasoning_effort ?? command.model?.reasoning_effort
  if (effort !== undefined && !info.reasoning?.efforts.some(item => String(item.id) === effort)) {
    throw new Error(`reasoning effort ${effort} is not supported by ${base.provider}/${base.model}`)
  }
  return {
    provider: base.provider,
    model: base.model,
    ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) },
  }
}

function mcpConfig(server: McpServerInput, taskCwd: string): McpClient.Config {
  const common = {
    serverName: normalizeMcpServerName(server.name),
    toolCallTimeoutMs: server.tool_call_timeout_ms ?? 60_000,
    failOnStartupError: true,
  }
  if (server.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd ?? taskCwd,
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: server.url,
    headers: server.headers,
  }
}

async function sameDirectory(left: string | undefined, right: string): Promise<boolean> {
  if (left === undefined) return false
  try {
    const [realLeft, realRight] = await Promise.all([realpath(left), realpath(right)])
    return realLeft === realRight
  } catch {
    return resolve(left) === resolve(right)
  }
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return block.text
    case 'image':
      return `[image attachment ${block.attachment.attachmentId}]`
    case 'file':
      return `[file attachment ${block.attachment.name} (${block.attachment.attachmentId})]`
    case 'tool-call':
      return `[tool call ${block.name}: ${block.arguments}]`
    case 'tool-addition':
    case 'tool-removal':
      // Developer-message bookkeeping about the tool set, never tool output.
      return ''
    default:
      return JSON.stringify(block)
  }
}

function observeSessionEvent(active: ActiveRun, session: Agent['session'], event: SessionEvent): void {
  if (active.agent?.session !== session || event.seq < active.firstSeq) return
  const requestId = active.command.request_id
  if (event.type === 'step/start' || event.type === 'turn/start') {
    for (const frame of inboxBoundaryFrames(active.inbox, requestId, event.type, event.seq)) writeFrame(frame)
  }
  if (event.type === 'assistant/message') {
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (text !== '') {
      active.lastText = text
      writeFrame({ v: PROTOCOL_VERSION, type: 'text', request_id: requestId, content: text })
    }
    for (const block of event.data.message.content) {
      if (block.type === 'reasoning' && block.text !== '') {
        writeFrame({ v: PROTOCOL_VERSION, type: 'thinking', request_id: requestId, content: block.text })
      }
    }
    const usage = event.data.usage
    if (usage !== undefined) {
      writeFrame({
        v: PROTOCOL_VERSION,
        type: 'usage',
        request_id: requestId,
        provider: event.data.message.source.provider,
        model: event.data.message.source.model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        ...usage.cacheReadTokens === undefined ? {} : { cache_read_tokens: usage.cacheReadTokens },
        ...usage.cacheWriteTokens === undefined ? {} : { cache_write_tokens: usage.cacheWriteTokens },
        ...usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens },
      })
    }
    return
  }
  if (event.type === 'tool/call') {
    const callId = String(event.data.callId)
    active.toolNames.set(callId, event.data.name)
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'tool_call',
      request_id: requestId,
      call_id: callId,
      name: event.data.name,
      arguments: event.data.arguments,
    })
    return
  }
  if (event.type === 'tool/result') {
    // DSH 0.2 commits the tool result as a ToolMessage: the call id and error
    // flag live on the message itself and `content` is the result payload.
    const message = event.data.message
    const callId = String(message.toolCallId)
    const rendered = truncateUtf8(message.content.map(renderBlock).join(''))
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'tool_result',
      request_id: requestId,
      call_id: callId,
      name: active.toolNames.get(callId) ?? 'unknown',
      output: rendered.value,
      is_error: message.isError === true,
      ...rendered.truncated ? { truncated: true } : {},
    })
    return
  }
  if (event.type === 'turn/end') active.endReason = event.data.reason
}

function subagentLifecycle(ctx: Context): SubagentLifecycle | undefined {
  return ctx.get('subagents') as SubagentLifecycle | undefined
}

/** Stop descendants, then converge the cancelled root without joining child-woken rounds. */
function settleCancelled(ctx: Context, agent: Agent): Promise<void> {
  return settleCancelledAgent(subagentLifecycle(ctx), agent, (error) => {
    writeDiagnostic(`subagent drain failed: ${errorMessage(error)}`)
  })
}

/** Settle any still-running descendants before the root handle is disposed. */
async function drainDescendants(ctx: Context, agent: Agent): Promise<void> {
  try {
    await subagentLifecycle(ctx)?.drainDescendants([agent])
  } catch (error: unknown) {
    writeDiagnostic(`subagent drain failed: ${errorMessage(error)}`)
  }
}

function resultFromReason(active: ActiveRun): Omit<Extract<OutboundFrame, { type: 'result' }>, 'v' | 'type' | 'request_id' | 'session_id'> {
  const reason = active.endReason
  if (active.cancelRequested) {
    return { status: 'cancelled', output: active.lastText, stop_reason: 'cancelled', resume_rejected: false }
  }
  if (reason?.kind === 'completed' || reason?.kind === 'max-tokens') {
    return { status: 'completed', output: active.lastText, stop_reason: reason.kind, resume_rejected: false }
  }
  if (reason?.kind === 'aborted') {
    return { status: 'aborted', output: active.lastText, stop_reason: reason.kind, resume_rejected: false }
  }
  if (reason?.kind === 'error') {
    return {
      status: 'failed',
      output: active.lastText,
      stop_reason: reason.kind,
      resume_rejected: false,
      error: { code: reason.error.code, message: reason.error.message },
    }
  }
  const stopReason = reason?.kind ?? 'no-turn-result'
  return {
    status: 'failed',
    output: active.lastText,
    stop_reason: stopReason,
    resume_rejected: false,
    error: { code: 'DSH_TURN_FAILED', message: `DSH turn ended with ${stopReason}` },
  }
}

/**
 * The inherited history of a summary-seeded session (S3-B2/M-138): ONE
 * user-message event carrying the parent's summary and this run's trigger.
 *
 * dsh's fork primitive replays a parent prefix; a cold parent's transcript is
 * exactly what the summary replaced, so replaying it would defeat the point.
 * The seed is therefore a single synthetic message at seq 0 — the child reads
 * it as the human's hand-over and then receives this run's prompt as usual.
 */
export function buildSummarySeed(text: string, now: number = Date.now()): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: SessionSeq(0),
    time: now,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }]
}

/**
 * The `agents.create` options for a summary-seeded child: the seed above, its
 * inherited length, and the fork lineage (`parentSession` + `isSeeded`) that
 * makes the child's provenance readable after the fact.
 */
export function seededCreateOptions(input: {
  cwd: string
  forkParent: string
  seed: string
  agentOptions: { provider: string; model: string }
  setup: AgentSetup
  now?: number
}): CreateAgentOptions {
  const seed = buildSummarySeed(input.seed, input.now)
  return {
    sessionId: SessionId(`multica-${randomUUID()}`),
    seed,
    inheritedEventCount: SessionLogOffset(seed.length),
    meta: {
      cwd: input.cwd,
      parentSession: SessionId(input.forkParent),
      isSeeded: true,
    },
    agentOptions: input.agentOptions,
    setup: input.setup,
  }
}

/** How a seeded start ended: the fork landed, or the named fallback resumed the parent. */
export type SeededStart =
  | { kind: 'forked'; handle: AgentHandle }
  | { kind: 'resumed'; handle: AgentHandle; reason: string }

/**
 * Start a session seeded from a summary, falling back to resuming the parent
 * when dsh refuses the seed.
 *
 * The fallback is the named one the daemon's run row depends on: a rejected
 * seed must not fail the run, and the caller reports it as a resume (the
 * `session` frame's `resumed: true`), so the row says "resumed warm" rather
 * than claiming a seed that never landed.
 */
export async function startSeeded(
  create: (options: CreateAgentOptions) => Promise<AgentHandle>,
  resumeParent: () => Promise<AgentHandle>,
  input: {
    cwd: string
    forkParent: string
    seed: string
    agentOptions: { provider: string; model: string }
    setup: AgentSetup
    now?: number
  },
): Promise<SeededStart> {
  try {
    return { kind: 'forked', handle: await create(seededCreateOptions(input)) }
  } catch (error: unknown) {
    if (!(error instanceof SessionForkError) && !(error instanceof Error && /seed/i.test(error.message))) {
      throw error
    }
    const reason = errorMessage(error)
    writeDiagnostic(`seeded start rejected for ${input.forkParent} (${reason}); resuming it instead`)
    return { kind: 'resumed', handle: await resumeParent(), reason }
  }
}

/**
 * Resume one persisted session in this run's working directory. A resume that
 * cannot load, or that loads a session created elsewhere, is a
 * ResumeRejectedError so the daemon can tell "the conversation is gone" from
 * "the runtime failed".
 */
async function resumeAgent(
  agents: AgentRegistry,
  options: ResumeAgentOptions,
  cwd: string,
): Promise<AgentHandle> {
  const sessionId = String(options.resumeSessionId)
  let handle: AgentHandle
  try {
    handle = await agents.resume(options)
  } catch (error: unknown) {
    throw new ResumeRejectedError(`could not resume DSH session ${sessionId}`, { cause: error })
  }
  if (!await sameDirectory(handle.agent.session.header.cwd, cwd)) {
    await handle.dispose()
    throw new ResumeRejectedError('the resumed DSH session belongs to a different working directory')
  }
  return handle
}

async function createOrResumeAgent(
  ctx: Context,
  active: ActiveRun,
  selection: ModelSelection,
): Promise<{ handle: AgentHandle; resumed: boolean }> {
  const agents = ctx.get('agents')
  if (agents === undefined) throw new Error('DSH agent registry is unavailable')
  const selected: ModelSelectionRef = { current: selection, assembled: undefined }
  const setup = async (agentCtx: Context): Promise<void> => {
    installModelSelection(agentCtx, selected)
    agentCtx.on('approval/request', (_request, next) => {
      if (active.cancelRequested) return Promise.resolve<ApprovalOutcome>('cancelled')
      return Promise.resolve<ApprovalOutcome>('allowed-once').catch(() => next())
    })
    // Ask/plan parity (M-109): claim every user-questions request — the
    // ask_user_question tool and exit_plan_mode's plan review both arrive
    // here — surface it on the stdio protocol, and resolve it with the
    // daemon's `answer` command carrying the human's reply.
    agentCtx.on('user-questions/request', (request, next) => {
      if (active.cancelRequested || request.signal?.aborted) return next()
      const callId = request.wait?.callId ?? `q-${randomUUID()}`
      writeFrame({
        v: PROTOCOL_VERSION,
        type: 'question',
        request_id: active.command.request_id,
        call_id: callId,
        questions: mapQuestionsForWire(request.questions),
      })
      const { promise, resolve, reject } = Promise.withResolvers<AskUserQuestionAnswer>()
      const onAbort = (): void => {
        if (active.pendingQuestion?.callId === callId) active.pendingQuestion = undefined
        reject(new Error('the ask was cancelled before the human answered'))
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      active.pendingQuestion = {
        callId,
        reject,
        resolve: (answers) => {
          request.signal?.removeEventListener('abort', onAbort)
          active.pendingQuestion = undefined
          resolve({ answers })
        },
      }
      return promise
    })
    for (const server of active.command.mcp_servers) {
      await agentCtx.plugin(McpClient, mcpConfig(server, active.command.cwd))
    }
  }
  const options = { provider: selection.provider, model: selection.model }
  if (active.command.fork_parent !== undefined) {
    // S3-B2 (M-138): a cold parent with a fresh summary. Fork a NEW session
    // seeded with the summary text; the daemon keeps the parent's id as the
    // fallback and records whichever of the two actually happened.
    const forkParent = active.command.fork_parent
    const start = await startSeeded(
      candidate => agents.create(candidate),
      () => resumeAgent(agents, { resumeSessionId: SessionId(forkParent), agentOptions: options, setup }, active.command.cwd),
      {
        cwd: active.command.cwd,
        forkParent,
        seed: active.command.seed ?? '',
        agentOptions: options,
        setup,
      },
    )
    return { handle: start.handle, resumed: start.kind === 'resumed' }
  }
  if (active.command.resume_session_id === undefined) {
    const handle = await agents.create({
      sessionId: SessionId(`multica-${randomUUID()}`),
      meta: { cwd: active.command.cwd },
      agentOptions: options,
      setup,
    })
    return { handle, resumed: false }
  }
  const handle = await resumeAgent(
    agents,
    { resumeSessionId: SessionId(active.command.resume_session_id), agentOptions: options, setup },
    active.command.cwd,
  )
  return { handle, resumed: true }
}

function rejectPendingInbox(active: ActiveRun): void {
  for (const entry of active.inbox.pending) {
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'inbox_state',
      request_id: active.command.request_id,
      command: entry.command,
      state: 'rejected',
      reason: 'run_finished',
    })
  }
  active.inbox.pending = []
}

async function execute(ctx: Context, active: ActiveRun): Promise<number> {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('DSH session service is unavailable')
  let handle: AgentHandle | undefined
  try {
    if (!isAbsolute(active.command.cwd)) throw new Error('execute.cwd must be an absolute path')
    const selection = await resolveSelection(ctx, active.command)
    const created = await createOrResumeAgent(ctx, active, selection)
    handle = created.handle
    active.agent = handle.agent
    await handle.agent.whenIdle()
    active.firstSeq = handle.agent.session.seq
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'session',
      request_id: active.command.request_id,
      session_id: String(handle.agent.session.id),
      resumed: created.resumed,
    })
    let outcome: 'settled' | 'cancelled' = active.cancelRequested ? 'cancelled' : 'settled'
    if (!active.cancelRequested) {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: active.command.prompt }],
        source: { kind: 'user' },
      }))
      outcome = await waitForQuiescence(subagentLifecycle(ctx), handle.agent, active.cancel.signal)
    }
    if (outcome === 'cancelled' || active.cancelRequested) await settleCancelled(ctx, handle.agent)
    else await drainDescendants(ctx, handle.agent)
    active.teardown = true
    await sessions.flush(handle.agent.session)
    const sessionId = String(handle.agent.session.id)
    rejectPendingInbox(active)
    const result = resultFromReason(active)
    await handle.dispose()
    handle = undefined
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: active.command.request_id,
      session_id: sessionId,
      ...result,
    })
    return result.status === 'completed' || result.status === 'cancelled' ? 0 : 1
  } catch (error: unknown) {
    if (handle !== undefined) {
      try {
        await settleCancelled(ctx, handle.agent)
        await sessions.flush(handle.agent.session)
        await handle.dispose()
      } catch (cleanupError: unknown) {
        writeDiagnostic(`cleanup failed: ${errorMessage(cleanupError)}`)
      }
    }
    active.teardown = true
    rejectPendingInbox(active)
    const resumeRejected = error instanceof ResumeRejectedError
    const cause = error instanceof Error && error.cause !== undefined ? `: ${errorMessage(error.cause)}` : ''
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: active.command.request_id,
      status: active.cancelRequested ? 'cancelled' : 'failed',
      output: active.lastText,
      resume_rejected: resumeRejected,
      error: {
        code: resumeRejected ? 'DSH_RESUME_REJECTED' : 'DSH_RUNTIME_ERROR',
        message: `${errorMessage(error)}${cause}`,
      },
    })
    return active.cancelRequested ? 0 : 1
  }
}

/**
 * One `summarize` first command (S3-B1): resume the idle session and run
 * dsh's own compaction over it, then report the summary on the `summary`
 * frame. The compaction replaces the session's long history span with the
 * summary node in place — the next resume reads the small summary, warm —
 * and the daemon stores the text beside the session. The process exits right
 * after the result frame: no idle session ever keeps this bridge alive.
 */
async function summarize(ctx: Context, command: SummarizeCommand): Promise<number> {
  const sessions = ctx.get('sessions')
  const compaction = ctx.get('compaction')
  if (sessions === undefined || compaction === undefined) {
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: command.request_id,
      status: 'failed',
      output: '',
      resume_rejected: false,
      error: { code: 'DSH_SUMMARIZE_UNAVAILABLE', message: 'DSH compaction services are unavailable in this runtime' },
    })
    return 1
  }
  let handle: AgentHandle | undefined
  try {
    const agents = ctx.get('agents')
    if (agents === undefined) throw new Error('DSH agent registry is unavailable')
    const selection = await resolveSelection(ctx, command)
    const options = { provider: selection.provider, model: selection.model }
    handle = await agents.resume({
      resumeSessionId: SessionId(command.session_id),
      agentOptions: options,
      setup: (agentCtx: Context): void => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined } satisfies ModelSelectionRef)
        // Compaction makes one model call; headless there is nobody to ask,
        // same allow-once posture the execute path takes.
        agentCtx.on('approval/request', (_request, next) =>
          Promise.resolve<ApprovalOutcome>('allowed-once').catch(() => next()))
      },
    })
    await handle.agent.whenIdle()
    const agent = handle.agent
    const result = await compaction.compactNow({
      session: agent.session,
      options,
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> => agent.runMaintenance(task),
    }, new AbortController().signal)
    if (result === null) {
      throw new Error('the session has no compactable history yet')
    }
    const text = result.summary
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const sessionId = String(agent.session.id)
    await sessions.flush(agent.session)
    await handle.dispose()
    handle = undefined
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'summary',
      request_id: command.request_id,
      session_id: sessionId,
      summary: text,
      summary_tokens: Math.ceil(text.length / 4),
    })
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: command.request_id,
      status: 'completed',
      session_id: sessionId,
      output: '',
      resume_rejected: false,
    })
    return 0
  } catch (error: unknown) {
    if (handle !== undefined) {
      try {
        await sessions.flush(handle.agent.session)
        await handle.dispose()
      } catch (cleanupError: unknown) {
        writeDiagnostic(`summarize cleanup failed: ${errorMessage(cleanupError)}`)
      }
    }
    writeFrame({
      v: PROTOCOL_VERSION,
      type: 'result',
      request_id: command.request_id,
      status: 'failed',
      output: '',
      resume_rejected: false,
      error: { code: 'DSH_SUMMARIZE_FAILED', message: errorMessage(error) },
    })
    return 1
  }
}

async function stdio(ctx: Context): Promise<number> {
  const forwarding = await installMulticaTerminalEnvironment(ctx)
  if (forwarding !== undefined && !forwarding.forwarded) {
    // Fail loudly at boot instead of twenty seconds later, as an opaque
    // "requires a task-scoped mat_ token" refusal on the agent's first
    // `multica` call (MUL-6186).
    writeDiagnostic(
      'MULTICA_TOKEN is not reaching model-spawned subprocesses; in-task multica commands will be refused',
    )
  }
  const activeRef: { current?: ActiveRun; finished: boolean } = { finished: false }
  ctx.on('session/event', (session, event: SessionEvent) => {
    if (activeRef.current !== undefined) observeSessionEvent(activeRef.current, session, event)
  })

  const input = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity })
  const firstCommand = Promise.withResolvers<FirstCommand>()
  let resolveExecute: ((command: FirstCommand) => void) | undefined = firstCommand.resolve
  let rejectExecute: ((error: Error) => void) | undefined = firstCommand.reject
  const firstExecute = firstCommand.promise
  input.on('line', (line) => {
    try {
      const command = parseInboundCommand(line)
      if (command.type === 'execute' || command.type === 'summarize') {
        if (activeRef.current !== undefined || resolveExecute === undefined) {
          protocolError('DUPLICATE_EXECUTE', 'this DSH process accepts exactly one first command')
          return
        }
        if (command.type === 'execute') {
          const active: ActiveRun = {
            command,
            firstSeq: Number.MAX_SAFE_INTEGER,
            cancelRequested: false,
            teardown: false,
            cancel: new AbortController(),
            lastText: '',
            toolNames: new Map(),
            inbox: { pending: [] },
          }
          activeRef.current = active
        }
        const resolveCommand = resolveExecute
        resolveExecute = undefined
        rejectExecute = undefined
        resolveCommand(command)
        return
      }
      const active = activeRef.current
      const outcome = dispatchInbound(
        active === undefined
          ? undefined
          : {
              requestId: active.command.request_id,
              finished: activeRef.finished,
              cancelRequested: active.cancelRequested,
              teardown: active.teardown,
              agent: active.agent,
              inbox: active.inbox,
            },
        command,
      )
      if (outcome.kind === 'deliver' || outcome.kind === 'reject') {
        writeFrame(outcome.frame)
        return
      }
      if (outcome.kind === 'drop') return
      // `act` means the command names this run while it lives: answer or cancel.
      if (active === undefined) return // unreachable: a missing run is answered with `drop`/`reject`
      if (command.type === 'answer') {
        if (!settlePendingQuestion(active.pendingQuestion, command)) {
          writeDiagnostic(`ignoring answer for unknown or settled question ${command.call_id}`)
        }
        return
      }
      active.cancelRequested = true
      active.pendingQuestion?.reject(new Error('the ask was cancelled before the human answered'))
      active.pendingQuestion = undefined
      active.cancel.abort()
      active.agent?.cancel({ kind: 'user' })
    } catch (error: unknown) {
      // A malformed line must not end a running task (M-134): report it and
      // keep the run — only an explicit `cancel` does that. Before `execute`
      // resolves, a bad line still fails startup.
      protocolError('INVALID_COMMAND', errorMessage(error))
      const active = activeRef.current
      if (active === undefined && rejectExecute !== undefined) {
        rejectExecute(new Error(errorMessage(error)))
        resolveExecute = undefined
        rejectExecute = undefined
      }
    }
  })
  input.on('close', () => {
    const active = activeRef.current
    if (active === undefined) {
      if (rejectExecute !== undefined) rejectExecute(new Error('stdin closed before execute'))
      return
    }
    if (!activeRef.finished) {
      active.cancelRequested = true
      active.pendingQuestion?.reject(new Error('the ask was cancelled before the human answered'))
      active.pendingQuestion = undefined
      active.cancel.abort()
      active.agent?.cancel({ kind: 'user' })
    }
  })

  writeFrame({
    v: PROTOCOL_VERSION,
    type: 'ready',
    runtime: 'dsh',
    plugin_version: PLUGIN_VERSION,
    capabilities: {
      resume: true,
      cancel: true,
      models: true,
      thinking: true,
      usage: true,
      tools: true,
      questions: true,
      steer: true,
      queue: true,
      summarize: ctx.get('compaction') !== undefined,
      // S3-B2 (M-138): seeded starts — `execute.fork_parent` + `execute.seed`.
      fork: true,
      mcp: ['stdio', 'streamable-http'],
    },
  })
  let first: FirstCommand
  try {
    first = await firstExecute
  } catch (error: unknown) {
    writeDiagnostic(errorMessage(error))
    input.close()
    return 1
  }
  if (first.type === 'summarize') {
    const code = await summarize(ctx, first)
    input.close()
    return code
  }
  const active = activeRef.current
  if (active === undefined) return 1
  const code = await execute(ctx, active)
  activeRef.finished = true
  input.close()
  return code
}

async function run(ctx: Context): Promise<void> {
  await ctx.get('loader')?.await()
  const appExit = ctx.get('appExit')
  const cmdlineArgs = ctx.get('cmdlineArgs')
  if (appExit === undefined || cmdlineArgs === undefined) {
    throw new Error('the DSH launcher did not provide cmdlineArgs/appExit')
  }
  let code = 1
  try {
    const mode = parseMode(cmdlineArgs.get())
    if (mode === 'probe') {
      writeFrame({
        v: PROTOCOL_VERSION,
        type: 'probe',
        runtime: 'dsh',
        plugin_version: PLUGIN_VERSION,
        protocol_version: PROTOCOL_VERSION,
      })
      code = 0
    } else if (mode === 'list-models') {
      writeFrame({ v: PROTOCOL_VERSION, type: 'models', models: await listModels(ctx) })
      code = 0
    } else {
      code = await stdio(ctx)
    }
  } catch (error: unknown) {
    writeDiagnostic(errorMessage(error))
    protocolError('STARTUP_FAILED', errorMessage(error))
  }
  appExit(code)
}

export function apply(ctx: Context): void {
  void run(ctx).catch((error: unknown) => {
    writeDiagnostic(errorMessage(error))
    ctx.get('appExit')?.(1)
  })
}

export * from './protocol.js'
export * from './environment.js'
