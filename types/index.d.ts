export type Req = {
  at: number
  model: string
  effort: string
  read: number
  create: number
  input: number
  output: number
  ttftMs?: number
  tps?: number
}

export type Change = {
  at: number
  reqIndex: number
  kind: 'model' | 'effort'
  from: string
  to: string
  hitAfter?: number
  predicted?: number
  wrote?: number
}

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type PastSession = {
  id: string
  startedAt: number
  requests: number
  hitRate: number
  changes: Change[]
}

export type UsageState = {
  startedAt: number
  reqs: Req[]
  changes: Change[]
  subagents: Record<string, { requests: number; tokens: number }>
  context?: { tokens?: number; window: number; percent?: number }
  rateLimits: RateLimit[]
  costUsd?: number
  compactions: number
  compactedAt?: number
  cacheExpiresAt?: number
  ttlMs: number
  isBandOn: boolean
  history: PastSession[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-panel': { s: UsageState }
  }
}
