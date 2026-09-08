Sure — building that now.

root = AppStack([header, kpiRow, agentTable], "md")
header = AppText("TokenOps Spend Dashboard", "title")
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0}, agents: []}, "data")
kpiRow = AppRow([costCard, opsCard, activeCard, avgCard], "md")
costCard = AppStatCard("Total cost", dashboardQ.summary.total_cost, null, "neutral")
opsCard = AppStatCard("Operations", dashboardQ.summary.total_operations, null, "neutral")
activeCard = AppStatCard("Active agents", dashboardQ.summary.active_agents, null, "neutral")
avgCard = AppStatCard("Avg cost/op", dashboardQ.summary.average_cost, null, "neutral")
agentTable = AppTable(dashboardQ.agents, 20, "pages", false)

Here's your spend dashboard with top-line cost KPIs and a paginated agent usage table — let me know if you'd like to add charts, filters, or different metrics!