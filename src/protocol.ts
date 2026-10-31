import { createHash } from 'node:crypto'

export const PROTOCOL_VERSION = 1 as const
export const MAX_COMMAND_BYTES = 8 * 1024 * 1024
export const MAX_TOOL_OUTPUT_BYTES = 256 * 1024

export interface ModelSelectionInput {
  provider: string
  id: string
  reasoning_effort?: string
}

interface McpServerBase {
  name: string
  tool_call_timeout_ms?: number
}

export interface StdioMcpServer extends McpServerBase {
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
}

export interface StreamableHttpMcpServer extends McpServerBase {
  transport: 'streamable-http'
  url: string
  headers: Record<string, string>
}

export type McpServerInput = StdioMcpServer | StreamableHttpMcpServer

export interface ExecuteCommand {
  v: typeof PROTOCOL_VERSION
  type: 'execute'
  request_id: string
  cwd: string
  prompt: string
  resume_session_id?: string
  /**
   * S3-B2 (M-138) seeded start: fork a NEW session from `fork_parent`, seeded
   * with `seed` instead of resuming it. Mutually exclusive with
   * `resume_session_id` — a fork starts a child session, a resume continues the
   * parent. Additive at protocol v1: the daemon sends both fields only after
   * the `ready` frame advertised the `fork` capability, so a bridge that
   * predates them never receives them.
   */
  fork_parent?: string
  /** The inherited text of a forked session: the parent's summary plus this run's trigger. */
  seed?: string
  model?: ModelSelectionInput
  reasoning_effort?: string
  mcp_servers: McpServerInput[]
}

export interface CancelCommand {
  v: typeof PROTOCOL_VERSION
  type: 'cancel'
  request_id: string
}

/**
 * Deliver a human message to the agent's runtime inbox at the next step
 * boundary (`steer`) or as the next turn (`queue`). Both are additive at
 * protocol v1; the daemon sends them only after the `ready` frame advertised
 * `steer`/`queue`, and reads the run's state back on the `inbox_state` frame.
 */
export interface SteerCommand {
  v: typeof PROTOCOL_VERSION
  type: 'steer'
  request_id: string
  message: string
}

export interface QueueCommand {
  v: typeof PROTOCOL_VERSION
  type: 'queue'
  request_id: string
  message: string
}

/**
 * Compact one idle session with dsh's own compaction seam and return the
 * summary (S3-B1 / M-137). It is a FIRST command — an alternative to
 * `execute` on a fresh stdio process — because the session's run has already
 * ended and its process with it; the daemon's per-session cache clock sends it
 * only when it fires at TTL−margin. Additive at protocol v1: a bridge that
 * predates it never advertises the `summarize` capability, and the daemon
 * never sends the command without that advertisement.
 */
export interface SummarizeCommand {
  v: typeof PROTOCOL_VERSION
  type: 'summarize'
  request_id: string
  session_id: string
  model?: ModelSelectionInput
}

export type FirstCommand = ExecuteCommand | SummarizeCommand

export type InboundCommand = ExecuteCommand | SummarizeCommand | CancelCommand | AnswerCommand | SteerCommand | QueueCommand

/** Every command that may follow `execute` on a run's stdio stream. */
export type PostExecuteCommand = Exclude<InboundCommand, FirstCommand>

export interface RuntimeModelFrame {
  id: string
  label: string
  provider: string
  default?: boolean
  thinking?: {
    supported_levels: Array<{ value: string; label: string; description?: string }>
    default_level?: string
  }
}

/** One selectable answer offered by an ask/plan question. */
export interface RuntimeQuestionOption {
  label: string
  description?: string
}

/**
 * Plan-review presentation intent, passed through from dsh's user-questions
 * seam unchanged: the question IS a plan submission, `approve` names the
 * option that approves it, and the question's `detail` carries the plan.
 */
export interface RuntimeQuestionIntent {
  kind: 'plan-review'
  approve: string
  callId?: string
}

/** One question of an outbound `question` frame; mirrors dsh's AskUserQuestionItem. */
export interface RuntimeQuestion {
  id: string
  question: string
  detail?: string
  header?: string
  options?: RuntimeQuestionOption[]
  multiSelect?: boolean
  intent?: RuntimeQuestionIntent
}

/** One question's answer in an `answer` command. */
export interface RuntimeAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/**
 * Resolves one parked ask. Additive at protocol v1: the daemon sends it only
 * after the bridge's ready frame advertised the `questions` capability, and a
 * bridge that predates it never emits a `question` frame. An answer for an
 * unknown or already-settled question is ignored with a stderr diagnostic —
 * a stale reply must not tear down the run.
 */
export interface AnswerCommand {
  v: typeof PROTOCOL_VERSION
  type: 'answer'
  request_id: string
  call_id: string
  answers: RuntimeAnswerItem[]
}

export type OutboundFrame =
  | {
    v: typeof PROTOCOL_VERSION
    type: 'ready'
    runtime: 'dsh'
    plugin_version: string
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
      summarize: boolean,
      /**
       * S3-B2 (M-138): this bridge can start a session seeded from a summary
       * (`execute.fork_parent` + `execute.seed`). The daemon sends a fork only
       * to a bridge that advertises it, so a deployment still running the
       * previous bridge keeps resuming.
       */
      fork: true,
      mcp: ['stdio', 'streamable-http'],
    }
  }
  | { v: typeof PROTOCOL_VERSION; type: 'probe'; runtime: 'dsh'; plugin_version: string; protocol_version: number }
  | { v: typeof PROTOCOL_VERSION; type: 'models'; models: RuntimeModelFrame[] }
  | { v: typeof PROTOCOL_VERSION; type: 'session'; request_id: string; session_id: string; resumed: boolean }
  /**
   * The summary dsh's compaction produced for a `summarize` command. The
   * daemon stores it beside the session (S3-B1); `summary_tokens` is the
   * bridge's bytes/4 estimate, good enough for the size record the decision
   * log keeps.
   */
  | { v: typeof PROTOCOL_VERSION; type: 'summary'; request_id: string; session_id: string; summary: string; summary_tokens: number }
  | { v: typeof PROTOCOL_VERSION; type: 'text'; request_id: string; content: string }
  | { v: typeof PROTOCOL_VERSION; type: 'thinking'; request_id: string; content: string }
  | { v: typeof PROTOCOL_VERSION; type: 'tool_call'; request_id: string; call_id: string; name: string; arguments: string }
  | { v: typeof PROTOCOL_VERSION; type: 'question'; request_id: string; call_id: string; questions: RuntimeQuestion[] }
  | {
    v: typeof PROTOCOL_VERSION
    type: 'tool_result'
    request_id: string
    call_id: string
    name: string
    output: string
    is_error: boolean
    truncated?: boolean
  }
  | {
    v: typeof PROTOCOL_VERSION
    type: 'usage'
    request_id: string
    provider: string
    model: string
    input_tokens: number
    output_tokens: number
    cache_read_tokens?: number
    cache_write_tokens?: number
    reasoning_tokens?: number
  }
  | {
    v: typeof PROTOCOL_VERSION
    type: 'result'
    request_id: string
    status: 'completed' | 'failed' | 'aborted' | 'cancelled'
    session_id?: string
    output: string
    stop_reason?: string
    resume_rejected: boolean
    error?: { code: string; message: string }
  }
  /**
   * Accepted/applied/rejected state of one inbound `steer` or `queue`, so the
   * daemon and UI can show whether the message reached the agent's inbox.
   * `reason` is carried on `rejected` only: `agent_not_ready`,
   * `run_finished`, `unknown_request_id`, or the delivery error text.
   */
  | { v: typeof PROTOCOL_VERSION; type: 'inbox_state'; request_id: string; command: 'steer' | 'queue'; state: 'accepted' | 'applied' }
  | { v: typeof PROTOCOL_VERSION; type: 'inbox_state'; request_id: string; command: 'steer' | 'queue'; state: 'rejected'; reason: string }
  | { v: typeof PROTOCOL_VERSION; type: 'protocol_error'; code: string; message: string }

/** One `inbox_state` frame in any of its three states. */
export type InboxStateFrame = Extract<OutboundFrame, { type: 'inbox_state' }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`)
  return value
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(value).filter(key => !allowedSet.has(key))
  if (extra.length > 0) throw new Error(`${field} contains unsupported field: ${extra.sort().join(', ')}`)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return requiredString(value, field)
}

function sessionId(value: unknown, field: string): string {
  const id = requiredString(value, field)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`${field} must be a valid session id`)
  return id
}

function optionalSessionId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return sessionId(value, field)
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`)
  }
  return [...value]
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {}
  const record = assertRecord(value, field)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') throw new Error(`${field}.${key} must be a string`)
    result[key] = item
  }
  return result
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive integer`)
  return Number(value)
}

function parseModel(value: unknown): ModelSelectionInput | undefined {
  if (value === undefined || value === null) return undefined
  const model = assertRecord(value, 'model')
  assertOnlyKeys(model, ['provider', 'id', 'reasoning_effort'], 'model')
  return {
    provider: requiredString(model.provider, 'model.provider'),
    id: requiredString(model.id, 'model.id'),
    ...optionalString(model.reasoning_effort, 'model.reasoning_effort') === undefined
      ? {}
      : { reasoning_effort: optionalString(model.reasoning_effort, 'model.reasoning_effort') },
  }
}

function parseMcpServer(value: unknown, index: number): McpServerInput {
  const field = `mcp_servers[${index}]`
  const server = assertRecord(value, field)
  const transport = requiredString(server.transport, `${field}.transport`)
  const timeout = optionalPositiveInteger(server.tool_call_timeout_ms, `${field}.tool_call_timeout_ms`)
  if (transport === 'stdio') {
    assertOnlyKeys(server, ['name', 'transport', 'command', 'args', 'env', 'cwd', 'tool_call_timeout_ms'], field)
    return {
      name: requiredString(server.name, `${field}.name`),
      transport,
      command: requiredString(server.command, `${field}.command`),
      args: stringArray(server.args, `${field}.args`),
      env: stringMap(server.env, `${field}.env`),
      ...optionalString(server.cwd, `${field}.cwd`) === undefined
        ? {}
        : { cwd: optionalString(server.cwd, `${field}.cwd`) },
      ...timeout === undefined ? {} : { tool_call_timeout_ms: timeout },
    }
  }
  if (transport === 'streamable-http') {
    assertOnlyKeys(server, ['name', 'transport', 'url', 'headers', 'tool_call_timeout_ms'], field)
    return {
      name: requiredString(server.name, `${field}.name`),
      transport,
      url: requiredString(server.url, `${field}.url`),
      headers: stringMap(server.headers, `${field}.headers`),
      ...timeout === undefined ? {} : { tool_call_timeout_ms: timeout },
    }
  }
  throw new Error(`${field}.transport must be stdio or streamable-http`)
}

function parseMcpServers(value: unknown): McpServerInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('mcp_servers must be an array')
  const servers = value.map(parseMcpServer)
  const names = new Set<string>()
  for (const server of servers) {
    const normalized = normalizeMcpServerName(server.name)
    if (names.has(normalized)) throw new Error(`mcp_servers contains duplicate normalized name: ${normalized}`)
    names.add(normalized)
  }
  return servers
}

export function parseInboundCommand(line: string): InboundCommand {
  if (Buffer.byteLength(line) > MAX_COMMAND_BYTES) throw new Error('protocol command exceeds 8 MiB')
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('protocol command is not valid JSON')
  }
  const command = assertRecord(parsed, 'command')
  if (command.v !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version: ${String(command.v)}`)
  const type = requiredString(command.type, 'command.type')
  if (type === 'cancel') {
    assertOnlyKeys(command, ['v', 'type', 'request_id'], 'cancel command')
    return {
      v: PROTOCOL_VERSION,
      type,
      request_id: requiredString(command.request_id, 'cancel.request_id'),
    }
  }
  if (type === 'answer') {
    assertOnlyKeys(command, ['v', 'type', 'request_id', 'call_id', 'answers'], 'answer command')
    const rawAnswers = command.answers
    if (!Array.isArray(rawAnswers)) throw new Error('answer.answers must be an array')
    const answers: RuntimeAnswerItem[] = rawAnswers.map((entry, index) => {
      const field = `answer.answers[${index}]`
      const item = assertRecord(entry, field)
      assertOnlyKeys(item, ['id', 'selected', 'custom'], field)
      const custom = optionalString(item.custom, `${field}.custom`)
      return {
        id: requiredString(item.id, `${field}.id`),
        selected: stringArray(item.selected, `${field}.selected`),
        ...custom === undefined ? {} : { custom },
      }
    })
    return {
      v: PROTOCOL_VERSION,
      type,
      request_id: requiredString(command.request_id, 'answer.request_id'),
      call_id: requiredString(command.call_id, 'answer.call_id'),
      answers,
    }
  }
  if (type === 'steer' || type === 'queue') {
    assertOnlyKeys(command, ['v', 'type', 'request_id', 'message'], `${type} command`)
    return {
      v: PROTOCOL_VERSION,
      type,
      request_id: requiredString(command.request_id, `${type}.request_id`),
      message: requiredString(command.message, `${type}.message`),
    }
  }
  if (type === 'summarize') {
    assertOnlyKeys(command, ['v', 'type', 'request_id', 'session_id', 'model'], 'summarize command')
    return {
      v: PROTOCOL_VERSION,
      type,
      request_id: requiredString(command.request_id, 'summarize.request_id'),
      session_id: sessionId(command.session_id, 'summarize.session_id'),
      ...parseModel(command.model) === undefined ? {} : { model: parseModel(command.model) },
    }
  }
  if (type === 'execute') {
    assertOnlyKeys(
      command,
      [
        'v', 'type', 'request_id', 'cwd', 'prompt', 'resume_session_id',
        'fork_parent', 'seed', 'model', 'reasoning_effort', 'mcp_servers',
      ],
      'execute command',
    )
    const forkParent = optionalSessionId(command.fork_parent, 'execute.fork_parent')
    const seed = optionalString(command.seed, 'execute.seed')
    if (forkParent !== undefined && command.resume_session_id !== undefined && command.resume_session_id !== '') {
      throw new Error('execute.fork_parent and execute.resume_session_id are mutually exclusive')
    }
    if (forkParent !== undefined && seed === undefined) {
      throw new Error('execute.fork_parent requires execute.seed')
    }
    if (forkParent === undefined && seed !== undefined) {
      throw new Error('execute.seed requires execute.fork_parent')
    }
    return {
      v: PROTOCOL_VERSION,
      type,
      request_id: requiredString(command.request_id, 'execute.request_id'),
      cwd: requiredString(command.cwd, 'execute.cwd'),
      prompt: requiredString(command.prompt, 'execute.prompt'),
      ...optionalSessionId(command.resume_session_id, 'execute.resume_session_id') === undefined
        ? {}
        : { resume_session_id: optionalSessionId(command.resume_session_id, 'execute.resume_session_id') },
      ...forkParent === undefined ? {} : { fork_parent: forkParent },
      ...seed === undefined ? {} : { seed },
      ...parseModel(command.model) === undefined ? {} : { model: parseModel(command.model) },
      ...optionalString(command.reasoning_effort, 'execute.reasoning_effort') === undefined
        ? {}
        : { reasoning_effort: optionalString(command.reasoning_effort, 'execute.reasoning_effort') },
      mcp_servers: parseMcpServers(command.mcp_servers),
    }
  }
  throw new Error(`unsupported protocol command type: ${type}`)
}

const VALID_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

export function normalizeMcpServerName(name: string): string {
  if (VALID_MCP_SERVER_NAME.test(name)) return name
  const slug = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 20) || 'server'
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8)
  return `${slug}_${digest}`.slice(0, 32)
}

export function truncateUtf8(value: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return { value, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xC0) end--
  return { value: `${bytes.subarray(0, end).toString('utf8')}\n[output truncated]`, truncated: true }
}

export function encodeFrame(frame: OutboundFrame): string {
  return `${JSON.stringify(frame)}\n`
}
