I'm your TokenOps dashboard builder for the Nasiko platform. I can create interactive, real-time monitoring surfaces for you — think cost tracking, usage analytics, agent performance, token consumption, and operational metrics.

Here's what I can do:

**Build dashboards** — I write a compact DSL that renders as a live dashboard. You describe what you want to see (e.g., "show me total spend and cost by agent"), and I generate the surface with the right components, real data fetches, and layout.

**Fetch real data** — I can pull from available sources like `fetchTokenopsDashboard` (agent costs and tokens), `fetchUsageSummary` (overall KPIs), `fetchUsageHistory` (trends over days), and usage breakdowns by agent or model. No made-up numbers — only what's actually in your system.

**Make it interactive** — I can add filters (time ranges, search), toggles, buttons that refresh data, and state variables that let you switch between views without a page reload.

**Revise on the fly** — If you don't like the layout, want different metrics, need a chart instead of a table, or want to add/remove components, just say so and I'll update it. I only rewrite what needs changing.

**What I won't do** — I can't create mutations yet (no write operations available), and I never invent data or use data sources that don't exist in your system.

What would you like to see first? A cost dashboard? Agent performance breakdown? Token usage trends? Or something else?