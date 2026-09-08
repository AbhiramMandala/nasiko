Sure — building that now.
root = AppStack([heading, summary, agentBreakdown], "md")
heading = AppText("Cost overview", "title")
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0}, agents: []})
summary = AppStatRow([{label: "Total cost", value: dashboardQ.summary.total_cost, sub: "all time"}, {label: "Operations", value: dashboardQ.summary.total_operations}, {label: "Last 24h ops", value: dashboardQ.summary.operations_last_24h}, {label: "Active agents", value: dashboardQ.summary.active_agents}])
agentRows = dashboardQ.agents
agentTable = AppTable(agentRows, 20, "pages", false)
agentBreakdown = AppCard([agentTable], "Cost by agent")
Here's your cost dashboard showing total spend, operation volume, and a per-agent breakdown — let me know if you'd like to dig into specific time periods or add trend comparisons!