import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'usage-panel',
  component: 'Pane',
  requestId: 'usage',
  props: { title: 'Usage', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BAND = {
  plugin: 'usage-panel',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} },
} as const

test('pane and band draw with data on every surface', async ($, on) => {
  let t = 1000
  on('clock.now', () => ({ value: (t += 500) }))
  on('session.id', () => ({ value: 'sess' }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.every', () => ({ value: {} as never }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'x',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 },
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { tokens: 1000, window: 200000, percent: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: '2030-01-01T00:00:00Z' }],
    cost: { usd: 1.5 },
    changed: ['context'],
  })
  for (const effort of ['high', 'low'] as const) {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort, messageCount: 1 })) {
      void _
    }
  }

  await $.session.measure({ context: { tokens: 1200, window: 200000, percent: 1 }, rateLimits: [], changed: ['context'] })
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-5-5', effort: 'low', messageCount: 1 })) {
    void _
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /Cache/ })).toBeTruthy()
    expect(await pane.find({ type: 'Text', text: /opus-5-5/ })).toBeTruthy()
    await pane.unmount()
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /cache/ })).toBeTruthy()
    await band.unmount()
  }
})
