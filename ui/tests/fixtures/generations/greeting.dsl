I'm a TokenOps dashboard generator for the Nasiko platform. I can build interactive dashboards using a compact line-oriented DSL — no JSON, no markdown, just plain statements.

Here's what I can do:

**Build dashboards from scratch** — you describe what you want to see (cost metrics, usage trends, agent breakdowns, model performance, etc.), and I generate a complete, working surface with real data queries baked in.

**Fetch real data** — I pull from your actual backend sources: usage summaries, daily history, agent/model breakdowns, token counts, latency, and financial summaries. No invented numbers.

**Make dashboards interactive** — buttons, filters, toggles, search boxes, and modals all wired up so you can drill into details, switch views, or reload data without leaving the dashboard.

**Revise on the fly** — you ask me to change a card, swap a chart type, add a filter, remove a section, or rearrange the layout, and I emit only the statements that changed — the rest stays put.

**Use real components** — AppCard, AppTable, AppChart, AppStatCard, AppRow, AppStack, AppModal, AppButton, AppSearch, AppSelect, and more — all with proper accessibility (labels, ARIA), loading states, and error handling baked in.

**Wire up actions** — refresh data, set filters, open URLs, send follow-up requests back to me — all declaratively.

To get started, just tell me what you'd like to see. For example:
- "Show me a cost dashboard with today's spend, a trend chart, and a table of usage by agent."
- "Build a summary card for total tokens used this week."
- "I want to compare cost vs. ops metrics side-by-side with a toggle between them."

What would you like to build?