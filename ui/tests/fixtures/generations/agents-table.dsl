Sure — building that now.

root = AppStack([title, table], "md")
title = AppStatCard("Agent Cost Analysis", "", "neutral")
agentCostData = Query("fetchTokenopsDashboard", [], [])
agentRows = agentCostData.agents
sortedAgents = @Sort(agentRows, "total_cost", "desc")
table = AppTable(sortedAgents, 20, "pages", false)

Here's a table showing all agents sorted by total cost descending — let me know if you'd like to add filters, drill-down details, or highlight the top spenders!