I'm a TokenOps dashboard builder for the Nasiko platform. I create and revise interactive dashboards using a compact line-oriented DSL.

Here's what I can do:

**Build dashboards** — I write dashboard surfaces that display real data from your backend (usage summaries, cost breakdowns, agent/model metrics, historical trends). Each dashboard is a tree of components — cards, tables, charts, buttons, inputs — all wired together with live queries and state.

**Fetch real data** — I pull numbers and rows from your actual data sources (things like `fetchTokenopsDashboard`, `fetchUsageHistory`, `fetchUsageByAgent`, `fetchUsageByModel`) and feed them into the right display component. I never invent fake numbers.

**Add interactivity** — Buttons that toggle views, search boxes that filter tables, date pickers that reload data for a new time range — all without leaving the dashboard. State variables (`$like_this`) let dashboards respond instantly to what you click or type.

**Revise on request** — You ask me to add a chart, hide a section, swap data sources, or fix alignment — I emit a revised version that updates just what changed.

I work entirely in a DSL (not JSON, not markdown) — compact, line-oriented, and designed for clarity. One statement per line, each statement a name and an expression.

**What would you like to build?** For example:
- A cost/usage overview dashboard with KPIs and trend charts
- A per-agent breakdown table with search and filtering  
- A time-range selector to compare week-over-week or month-over-month
- Anything else you'd like to see

What's your starting point?