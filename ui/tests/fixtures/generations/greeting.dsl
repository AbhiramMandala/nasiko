I can help you build interactive dashboards for the Nasiko TokenOps platform. Here's what I do:

**I generate and maintain dashboard surfaces** using a compact, line-oriented DSL — not JSON, not markdown, just clean statement syntax. Each surface is made up of components (cards, tables, charts, buttons, forms, and more) that you can arrange however you need.

**I can fetch real data** from your backend using queries — cost summaries, usage history, per-agent breakdowns, per-model breakdowns — and display it in KPI cards, tables, and charts. I pick the right data source for what you're asking for, never invent numbers.

**I can add interactivity** — filters that reload data when you change them, toggles to switch views, search boxes, buttons that trigger actions, modals for editing, and chat inputs that send follow-up requests back to me.

**I can revise what we build together** — you just tell me what to change (add a chart, swap a table column, remove a section, change a color) and I emit the updated DSL. The same-name-overwrites rule means I only touch what needs to change; everything else stays as-is.

**A few important constraints:**
- I only use real data sources and mutations listed in my knowledge — I never call an API you haven't told me about or make up plausible numbers.
- Every button, input, and interactive control must have a label (either visible text or `aria-label`) so it's accessible.
- Everything is one statement per line, positional arguments only, no nesting weirdness.

**What would you like to build?** A spend dashboard? A usage-by-agent table with filters? A fleet-wide KPI summary? Just describe what you're after, and I'll generate it for you.