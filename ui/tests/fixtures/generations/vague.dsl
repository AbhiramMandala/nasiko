Sure — building that now.

root = AppStack([header, kpis, chart, table], "md")
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0}, agents: []})
header = AppText("Cost overview", "title")
kpis = AppRow([costCard, opsCard, activeCard], "md")
costCard = AppStatCard("Total cost", dashboardQ.summary.total_cost, null, "neutral")
opsCard = AppStatCard("Total operations", dashboardQ.summary.total_operations, null, "neutral")
activeCard = AppStatCard("Active agents", dashboardQ.summary.active_agents, null, "neutral")
chart = AppChart({labels: ["Cost per agent"], datasets: [{label: "Cost (USD)", data: [dashboardQ.summary.average_cost]}]}, "bar", false, "currency", "USD")
agentRows = Query("fetchUsageByAgent", ["", 1, 20], [], "data")
table = AppTable(agentRows, 20, "pages", true)

Here's your cost dashboard with headline metrics, a chart showing average cost, and a breakdown by agent — let me know if you'd like to adjust the view or add more details!