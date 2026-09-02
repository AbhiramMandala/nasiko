Sure — building that now.
root = AppStack([title, table], "md")
title = AppCard(null, "Agent costs", null, null, "Which agents cost the most?")
agentRows = Query("fetchTokenopsDashboard", [], [], "data.agents")
table = AppTable(agentRows, 20, "pages", false)
Here's a table showing all agents ranked by their total costs, with full usage breakdowns — let me know if you'd like to filter by date range or add any other metrics!