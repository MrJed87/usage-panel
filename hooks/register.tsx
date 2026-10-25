import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Change, PastSession, Req, UsageState } from '../types'

const PANE = 'usage'
const BARS = '▁▂▃▄▅▆▇█'
const SPARK_WIDTH = 40
const MAX_REQS = 200
const MAX_HISTORY = 30
const TWO_MIN = 2 * 60 * 1000
const MIN_COMPACT_TOKENS = 100000
const FIVE_MIN = 5 * 60 * 1000
const ONE_HOUR = 60 * 60 * 1000

const initial: UsageState = {
  startedAt: 0,
  reqs: [],
  changes: [],
  subagents: {},
  rateLimits: [],
  compactions: 0,
  ttlMs: FIVE_MIN,
  isBandOn: true,
  isAutoCompact: false,
  leadMs: TWO_MIN,
  history: [],
}

const s = atom({ plugin: 'usage-panel', key: 's' } as const, initial)

const hit = (r: Req) => {
  const total = r.read + r.create + r.input

  return total === 0 ? 0 : Math.round((r.read / total) * 100)
}

const avgHit = (reqs: readonly Req[]) => {
  const read = reqs.reduce((n, r) => n + r.read, 0)
  const total = reqs.reduce((n, r) => n + r.read + r.create + r.input, 0)

  return total === 0 ? 0 : Math.round((read / total) * 100)
}

const tokens = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))

const clock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)

  return `${m}:${String(total % 60).padStart(2, '0')}`
}

const promptSize = (r: Req) => r.read + r.create + r.input

const span = (ms: number) => {
  const mins = Math.max(0, Math.round(ms / 60000))
  const d = Math.floor(mins / 1440)
  const hr = Math.floor((mins % 1440) / 60)
  const m = mins % 60

  return d > 0 ? `${d}d ${hr}h` : hr > 0 ? `${hr}h ${m}m` : `${m}m`
}

const shortModel = (m: string) => m.replace(/^claude-/, '')

const hitColor = (pct: number) => (pct >= 80 ? 'green' : pct >= 40 ? 'yellow' : 'red')

const spark = (reqs: readonly Req[]) => {
  const view = reqs.slice(-SPARK_WIDTH)

  return view.map(r => BARS[Math.min(7, Math.floor((hit(r) / 100) * 8))]).join('')
}

const markers = (reqs: readonly Req[], changes: readonly Change[]) => {
  const first = reqs.length - Math.min(reqs.length, SPARK_WIDTH)
  const cells = Array.from({ length: reqs.length - first }, () => ' ')
  for (const c of changes) {
    if (c.reqIndex >= first && c.reqIndex < reqs.length) {
      cells[c.reqIndex - first] = '▲'
    }
  }

  return cells.join('')
}

const describe = (c: Change) =>
  `${c.kind} ${c.from} → ${c.to}, first request after: ${c.hitAfter === undefined ? 'n/a' : c.hitAfter + '% hit'}` +
  (c.predicted === undefined || c.wrote === undefined ? '' : ` · predicted ~${tokens(c.predicted)}, wrote ${tokens(c.wrote)}`)

export const register: Register = on => {
  let ticker: { cancel: () => void } | undefined
  let sessionId = ''
  let toastedFor = 0

  on('session.start', async ($, e, next) => {
    sessionId = await $.session.id()
    const now = await $.clock.now()
    const stored = (await $.store.get('sessions')) as PastSession[] | undefined
    await update($, s, st => ({
      ...st,
      startedAt: st.startedAt || now,
      history: Array.isArray(stored) ? stored : st.history,
    }))

    await $.command.register({ name: 'usage-panel', description: 'Toggle the Usage side pane' })
    await $.command.register({ name: 'usage-band', description: 'Toggle the one-line usage band above the prompt' })
    await $.command.register({ name: 'usage-autocompact', description: 'Toggle compacting the chat 2 minutes before its cache goes cold' })
    void $.ui.open({ id: PANE, title: 'Usage' })

    ticker?.cancel()
    ticker = $.clock.every(1000, async () => {
      const at = await $.clock.now()
      let isLive = false
      let isCold = false
      let isDue = false
      let isMissed = false
      let before = 0
      let st0Lead = 0
      await update($, s, st => {
        const exp = st.cacheExpiresAt
        if (exp !== undefined) {
          isLive = at < exp + 2000
          if (at >= exp && toastedFor !== exp) {
            toastedFor = exp
            isCold = true
            isMissed = st.isAutoCompact && st.autoCompactedFor !== exp
          }
          const tokensNow = st.context?.tokens ?? 0
          if (st.isAutoCompact && st.autoCompactedFor !== exp && at >= (st.autoRetryAt ?? 0) && at < exp && exp - at <= st.leadMs && tokensNow >= MIN_COMPACT_TOKENS) {
            isDue = true
            before = tokensNow
            st0Lead = exp - at

            return { ...st, autoRetryAt: at + 120000, autoNote: 'Auto-compact running…' }
          }
        }

        return st
      })
      if (isDue) {
        try {
          const done = await $.session.compact()
          if (done.skip !== undefined) {
            const note = 'Auto-compact skipped: ' + done.skip
            await update($, s, st => ({ ...st, autoCompactedFor: st.cacheExpiresAt, autoNote: note }))
            $.ui.toast(note, { timeoutMs: 10000 })
          } else {
            const doneAt = await $.clock.now()
            const after = done.tokensAfter === undefined ? '' : ` → ${tokens(done.tokensAfter)}`
            const note = `Auto-compacted ${tokens(before)}${after} tokens before the cache went cold.`
            await update($, s, st => ({
              ...st,
              compactions: st.compactions + 1,
              compactedAt: doneAt,
              cacheExpiresAt: undefined,
              autoNote: note,
            }))
            $.ui.toast(note, { timeoutMs: 10000 })
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          let how = ''
          if (/headless|not available/i.test(reason)) {
            // the desktop app and the SDK compact inside a turn, so ask for it the way a person would: /compact
            try {
              await $.command.run({ command: 'compact' })
              how = 'ran /compact as a command'
            } catch {
              try {
                await $.prompt.submit({ text: '/compact', asUser: true })
                how = 'submitted /compact as a prompt'
              } catch {
                how = ''
              }
            }
          }
          const note =
            how === ''
              ? 'Auto-compact failed, will retry in 2 min: ' + reason
              : `Auto-compact ${how} (${tokens(before)} tokens, cache had ${span(st0Lead)} left).`
          await update($, s, st => ({ ...st, autoNote: note, autoCompactedFor: how === '' ? st.autoCompactedFor : st.cacheExpiresAt }))
          $.ui.toast(note, { timeoutMs: 10000 })
        }
      }
      if (isCold) {
        $.ui.toast(
          isMissed
            ? 'Prompt cache went cold before auto-compact could run (asleep, below the size threshold, or a turn was running). Compacting now would cost a full re-read, so it was skipped.'
            : 'Prompt cache went cold: the next message re-reads the whole chat at full price.',
          { timeoutMs: 10000 },
        )
      }
      if (isLive) {
        $.ui.invalidate('ui.render')
      }
    })

    return next(e)
  })

  on('command.run', { command: 'usage-panel' }, async $ => {
    const isUp = (await $.ui.panes()).some(p => p.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })

      return { text: 'Usage pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Usage' })

    return { text: opened.isPlaced ? 'Usage pane opened.' : 'Usage pane is waiting for room: widen the window.' }
  })

  on('command.run', { command: 'usage-autocompact' }, async ($, e) => {
    const minutes = Number.parseInt(e.args.trim(), 10)
    const hasLead = Number.isFinite(minutes) && minutes >= 1 && minutes <= 59
    let isOn = false
    let lead = TWO_MIN
    await update($, s, st => {
      isOn = hasLead ? true : !st.isAutoCompact
      lead = hasLead ? minutes * 60 * 1000 : st.leadMs
      const next = { ...st, isAutoCompact: isOn, leadMs: lead }

      return hasLead ? { ...next, autoCompactedFor: undefined } : next
    })

    return {
      text: isOn
        ? `Auto-compact on: the chat is compacted when its cache has ${span(lead)} left, if it holds ${tokens(MIN_COMPACT_TOKENS)}+ tokens. (/usage-autocompact 1-59 sets the minutes; the default is 2.)`
        : 'Auto-compact off.',
    }
  })

  on('command.run', { command: 'usage-band' }, async $ => {
    let isOn = false
    await update($, s, st => {
      isOn = !st.isBandOn

      return { ...st, isBandOn: isOn }
    })

    return { text: isOn ? 'Usage band on.' : 'Usage band off.' }
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    let firstAt = 0
    const stream = next(e)
    let result
    for (;;) {
      const step = await stream.next()
      if (step.done) {
        result = step.value
        break
      }
      if (firstAt === 0) {
        firstAt = await $.clock.now()
      }
      yield step.value
    }

    const usage = result?.usage
    if (usage) {
      const endedAt = await $.clock.now()
      const effort = String(e.effort ?? 'default')
      const streamMs = endedAt - startedAt
      const req: Req = {
        at: endedAt,
        model: usage.model,
        effort,
        read: usage.cache_read_input_tokens,
        create: usage.cache_creation_input_tokens,
        input: usage.input_tokens,
        output: usage.output_tokens,
        ttftMs: firstAt === 0 ? undefined : firstAt - startedAt,
        tps: streamMs > 0 ? Math.round((usage.output_tokens / streamMs) * 1000) : undefined,
      }
      const agentId = e.agentId
      let toast = ''
      await update($, s, st => {
        if (agentId !== undefined) {
          const old = st.subagents[agentId] ?? { requests: 0, tokens: 0 }
          const total = req.read + req.create + req.input + req.output

          return {
            ...st,
            subagents: { ...st.subagents, [agentId]: { requests: old.requests + 1, tokens: old.tokens + total } },
          }
        }

        const prev = st.reqs[st.reqs.length - 1]
        const index = st.reqs.length
        const changes = [...st.changes]
        const rate = hit(req)
        if (prev && prev.model !== req.model) {
          const before = promptSize(prev)
          const known = [...st.reqs].reverse().find(r => r.model === req.model)
          const isWarm = known !== undefined && known.at > (st.compactedAt ?? 0) && startedAt - known.at < st.ttlMs
          const predicted = known !== undefined && isWarm ? Math.max(0, before - promptSize(known)) : before
          const c: Change = {
            at: endedAt,
            reqIndex: index,
            kind: 'model',
            from: shortModel(prev.model),
            to: shortModel(req.model),
            hitAfter: rate,
            predicted,
            wrote: req.create + req.input,
          }
          changes.push(c)
          toast = `After ${c.kind} change ${c.from} → ${c.to}: ${rate}% of the prompt came from cache.`
        }
        if (prev && prev.effort !== req.effort) {
          const c: Change = { at: endedAt, reqIndex: index, kind: 'effort', from: prev.effort, to: req.effort, hitAfter: rate }
          changes.push(c)
          toast = `After ${c.kind} change ${c.from} → ${c.to}: ${rate}% of the prompt came from cache.`
        }
        const isCaching = req.read + req.create > 0

        return {
          ...st,
          reqs: [...st.reqs, req].slice(-MAX_REQS),
          changes: changes.slice(-50),
          first: st.first ?? req,
          cacheExpiresAt: isCaching ? endedAt + st.ttlMs : st.cacheExpiresAt,
        }
      })
      if (toast !== '') {
        $.ui.toast(toast, { timeoutMs: 8000 })
      }
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, s, st => ({
      ...st,
      context: { tokens: e.context.tokens, window: e.context.window, percent: e.context.percent },
      rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
      costUsd: e.cost?.usd,
      ttlMs: e.rateLimits.length > 0 ? ONE_HOUR : FIVE_MIN,
    }))

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId === undefined && e.trigger !== 'precompute') {
      const at = await $.clock.now()
      await update($, s, st => ({ ...st, compactions: st.compactions + 1, compactedAt: at, cacheExpiresAt: undefined }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && sessionId !== '') {
      let sessions: PastSession[] = []
      await update($, s, st => {
        if (st.reqs.length === 0) {
          return st
        }
        const mine: PastSession = {
          id: sessionId,
          startedAt: st.startedAt,
          requests: st.reqs.length,
          hitRate: avgHit(st.reqs),
          changes: st.changes.slice(-20),
        }
        sessions = [...st.history.filter(x => x.id !== sessionId), mine].slice(-MAX_HISTORY)

        return { ...st, history: sessions }
      })
      if (sessions.length > 0) {
        await $.store.set('sessions', sessions)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const st = await read($, s)
    const now = await $.clock.now()
    const last = st.reqs[st.reqs.length - 1]
    const lastHit = last ? hit(last) : 0
    const left = st.cacheExpiresAt === undefined ? undefined : st.cacheExpiresAt - now
    const ttlName = st.ttlMs === ONE_HOUR ? '1h (subscription)' : '5m (API key)'
    const ctx = st.context
    const past = st.history.filter(p => p.requests > 0).slice(-5).reverse()
    const agents = Object.entries(st.subagents)
    const lastByModel = new Map<string, Req>()
    for (const r of st.reqs) {
      lastByModel.set(r.model, r)
    }
    const others = [...lastByModel.values()].filter(r => last !== undefined && r.model !== last.model)

    return (
      <Box flexDirection="column">
        <Text bold>Cache</Text>
        {last === undefined ? (
          <Text dimColor>No request yet.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              last <Text color={hitColor(lastHit)}>{lastHit}%</Text> · session avg {avgHit(st.reqs)}% · read {tokens(last.read)} · wrote {tokens(last.create)} · fresh {tokens(last.input)}
            </Text>
            <Text color="cyan">{spark(st.reqs)}</Text>
            <Text color="yellow">{markers(st.reqs, st.changes)}</Text>
            {st.changes.length === 0 ? (
              <Text dimColor>▲ marks a model or effort change. None yet.</Text>
            ) : (
              st.changes.slice(-3).map(c => <Text color="yellow">▲ {describe(c)}</Text>)
            )}
          </Box>
        )}
        <Text>
          TTL{' '}
          {left === undefined ? (
            <Text dimColor>unknown until the first cached response</Text>
          ) : left > 0 ? (
            <Text color={left < 120000 ? 'yellow' : 'green'}>{clock(left)} left</Text>
          ) : (
            <Text color="red">COLD</Text>
          )}{' '}
          <Text dimColor>[{ttlName}, inferred from your plan]</Text>
        </Text>
        <Text dimColor>
          {st.isAutoCompact
            ? `Auto-compact on: at ${span(st.leadMs)} left, if context ≥ ${tokens(MIN_COMPACT_TOKENS)}` +
              (left !== undefined && left > st.leadMs ? ` · fires in ${span(left - st.leadMs)}` : '')
            : 'Auto-compact off (/usage-autocompact)'}
        </Text>
        {st.autoNote === undefined ? null : <Text color="yellow">{st.autoNote}</Text>}
        {st.first === undefined ? null : (
          <Text dimColor>
            {`First request: read ${tokens(st.first.read)} · wrote ${tokens(st.first.create)} (${hit(st.first)}% hit)`}
          </Text>
        )}

        <Text bold>{'\n'}Context</Text>
        {ctx === undefined || ctx.tokens === undefined ? (
          <Text dimColor>Waiting for the first response.</Text>
        ) : (
          <Text>
            {tokens(ctx.tokens)} / {tokens(ctx.window)} ({ctx.percent ?? 0}%) · compactions {st.compactions}
          </Text>
        )}

        <Text bold>{'\n'}Requests</Text>
        {last === undefined ? (
          <Text dimColor>-</Text>
        ) : (
          <Text>
            {shortModel(last.model)} · effort {last.effort} · {st.reqs.length} requests
            {last.ttftMs === undefined ? '' : ` · TTFT ${(last.ttftMs / 1000).toFixed(1)}s`}
            {last.tps === undefined ? '' : ` · ${last.tps} tok/s`}
          </Text>
        )}

        <Text bold>{'\n'}Switch cost</Text>
        {last === undefined || others.length === 0 ? (
          <Text dimColor>Only one model used this session.</Text>
        ) : (
          others.map(r => {
            const age = now - r.at
            const isCompacted = st.compactedAt !== undefined && r.at < st.compactedAt
            const isWarm = age < st.ttlMs && !isCompacted
            const size = promptSize(last)
            const gap = Math.max(0, size - promptSize(r))

            return (
              <Text>
                {shortModel(r.model)} · used {span(age)} ago ·{' '}
                {isWarm ? (
                  <Text color="green">warm, {span(st.ttlMs - age)} left</Text>
                ) : (
                  <Text color="red">{isCompacted ? 'cold (compacted since)' : 'cold'}</Text>
                )}{' '}
                · {isWarm ? `~${tokens(gap)} to catch up` : `~${tokens(size)} full rewrite`}
              </Text>
            )
          })
        )}

        <Text bold>{'\n'}Plan limits</Text>
        {st.rateLimits.length === 0 ? (
          <Text dimColor>None reported (needs a subscription).</Text>
        ) : (
          st.rateLimits.map(r => (
            <Text>
              {r.kind === 'five_hour' ? '5-hour' : r.kind === 'seven_day' ? '7-day' : r.kind} {r.percentUsed}%
              {r.resetsAt === undefined ? '' : ` · resets in ${span(Date.parse(r.resetsAt) - now)}`}
            </Text>
          ))
        )}
        <Text>
          Session cost {st.costUsd === undefined ? 'unavailable' : '$' + st.costUsd.toFixed(2)} <Text dimColor>(API-equivalent)</Text>
        </Text>

        <Text bold>{'\n'}Subagents</Text>
        {agents.length === 0 ? (
          <Text dimColor>None this session.</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{agents.length} spawned (token counts are context only, no per-agent cost)</Text>
            {agents.slice(-8).map(([id, a]) => (
              <Text>
                {id.slice(0, 8)} · {a.requests} requests · {tokens(a.tokens)} tokens
              </Text>
            ))}
          </Box>
        )}

        <Text bold>{'\n'}Past sessions</Text>
        {past.length === 0 ? (
          <Text dimColor>None saved yet.</Text>
        ) : (
          past.map(p => (
            <Box flexDirection="column">
              <Text>
                {new Date(p.startedAt).toISOString().slice(0, 16).replace('T', ' ')} · {p.requests} req · {p.hitRate}% hit
              </Text>
              {p.changes.slice(-3).map(c => (
                <Text dimColor>  ▲ {describe(c)}</Text>
              ))}
            </Box>
          ))
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const st = await read($, s)
    const last = st.reqs[st.reqs.length - 1]
    if (e.props.hasSurvey || !st.isBandOn || last === undefined) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const left = st.cacheExpiresAt === undefined ? undefined : st.cacheExpiresAt - now
    const rate = hit(last)

    return (
      <Box>
        <Text dimColor>
          cache <Text color={hitColor(rate)}>{rate}%</Text> · TTL {left === undefined ? '-' : left > 0 ? clock(left) : 'COLD'} · ctx {st.context?.percent ?? 0}% · {shortModel(last.model)} / {last.effort}
        </Text>
      </Box>
    )
  })
}
