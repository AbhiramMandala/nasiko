Sure — building that now.
root = AppStack([heading, table], "md")
heading = AppStatCard("Top agents by cost", totalCostQ, null, "neutral")
totalCostQ = Query("fetchTokenopsDashboard", [], 0, "data.summary.total_cost")
agentRows = Query("fetchTokenopsDashboard", [], [], "data.agents")
sortedAgents = @Sort(agentRows, "total_cost", "desc")
table = AppTable(sortedAgents, 20, "pages", false)
Here's a cost breakdown table showing which agents cost the most, sorted from highest to lowest — let me know if you'd like to filter, search, or add more detail!