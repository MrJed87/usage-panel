# usage-panel

A read-only Claude Code mod: a side pane and a one-line band that show your usage live.

- **Cache:** hit rate per request, session average, tokens read/written/fresh, and a sparkline with a ▲ wherever the model or effort changed (plus the hit rate of the request right after it, and a toast).
- **Cache TTL countdown:** 1h on a subscription, 5m otherwise. Inferred from your plan, not read from the API response.
- **Context:** tokens, window, percent, compaction count.
- **Requests:** model, effort, request count, time to first token, tokens/sec (output tokens over total request time).
- **Plan limits and cost:** 5-hour and 7-day usage with reset timers, API-equivalent session cost.
- **Subagents:** requests and tokens each (no per-agent cost is available).
- **Past sessions:** kept across sessions with `$.store`.

Commands: `/usage-panel` toggles the pane, `/usage-band` toggles the band above the prompt.

It makes no model calls, starts no processes, uses no network, and never holds, changes or approves a tool call. It does observe `session.compact` to count compactions.

## Install

Terminal prompt:

```
/plugin install usage-panel --marketplace MrJed87/usage-panel
```

Shell:

```
claude plugin install usage-panel --marketplace MrJed87/usage-panel
```

Desktop app: click + next to the prompt box, then Plugins, Add marketplace with `MrJed87/usage-panel`, then Add plugin.

Needs a Claude Code build with mods (2.1.286+ in the desktop app). The mods API is early access and may change.
