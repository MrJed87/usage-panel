# usage-panel

A read-only Claude Code mod: a side pane and a one-line band that show your usage live.

- **Cache:** hit rate per request, session average, tokens read/written/fresh, and a sparkline with a ▲ wherever the model or effort changed (plus the hit rate of the request right after it, and a toast).
- **Cache TTL countdown:** 1h on a subscription, 5m otherwise. Inferred from your plan, not read from the API response.
- **Context:** tokens, window, percent, compaction count.
- **Requests:** model, effort, request count, time to first token, tokens/sec (output tokens over total request time).
- **Plan limits and cost:** 5-hour and 7-day usage with reset timers, API-equivalent session cost.
- **Switch cost:** per model used this session, how long ago, whether its cache is still warm, and about how many tokens a switch back would have to catch up (or a full rewrite if cold).
- **First request:** read vs written tokens of the session's first request, so a cold resume is visible.
- **Subagents:** requests and tokens each (no per-agent cost is available).
- **Past sessions:** kept across sessions with `$.store`.

Commands: `/usage-panel` toggles the pane, `/usage-band` toggles the band above the prompt, `/usage-autocompact` toggles auto-compact.

**Auto-compact (off by default):** when on, and the cache has 2 minutes left and the context holds 100k+ tokens, the mod compacts the chat while the cache is still warm, so coming back after the cache goes cold only rewrites the summary. This changes your conversation (a summary replaces detail) and spends a little usage on the summary request, so it is opt-in. If you come back in the last two minutes, it will have compacted for nothing.

It makes no model calls of its own, starts no processes, uses no network, and never holds, changes or approves a tool call. The only thing it does to your session is the optional auto-compact above (`$.session.compact`). It observes `session.compact` to count compactions.

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
