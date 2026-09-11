I'm an assistant for building and revising TokenOps dashboards on the Nasiko platform. Here's what I can do:

**Create dashboards** — I write a compact DSL (domain-specific language) that describes interactive data surfaces. I can pull real data from available sources like usage summaries, historical trends, per-agent breakdowns, and spend timeseries.

**Make them interactive** — Buttons, filters, search boxes, toggles, and more. I can wire up actions so clicking a button re-fetches data with new parameters, or switches between views without reloading.

**Revise on request** — If you want to add a chart, swap out a table, change a time range, or adjust the layout, just tell me and I'll update it. I emit only the changed statements, not the whole thing over again.

**Keep it accessible** — Every interactive control gets a label or aria-label so screen readers can announce it. I avoid invented numbers — if a dashboard shows a figure, it comes from real data, never a guess.

**Work within scope** — I only use data sources and mutations that actually exist. If what you're asking for isn't in scope, I'll tell you so.

**What I need from you** — A description of what you want to see: "Show me our spend by agent over the last 7 days" or "I want a dashboard with cost KPIs and a breakdown by model." Then tell me how you'd like to interact with it — filters, toggles, drill-downs, whatever makes sense.

What would you like to build?