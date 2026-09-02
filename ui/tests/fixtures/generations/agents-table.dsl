Sure — building that now.

root = AppStack([title, table], "md")
title = AppStatCard("Agent Costs", null, null, "neutral", false)
agentCostData = Query("fetchTokenopsDashboard", [], [], "data.agents")
table = AppTable(agentCostData, 20, "pages", false)

Here's a table showing all your agents with their costs — you can sort by any column to find your top spenders, and page through to see the full breakdown!