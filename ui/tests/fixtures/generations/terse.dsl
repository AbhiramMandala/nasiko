Sure — building that now.
root = AppStack([header, kpis, table], "md")
header = AppRow([title], "md")
title = AppCard(null, "TokenOps Spend Dashboard")
kpis = AppRow([costCard, opsCard, agentsCard], "md")
costQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
opsQ = Query("fetchUsageSummary", [], 0, "request_count")
summaryQ = Query("fetchUsageSummary", [], {total_agents: 0})
costCard = AppStatCard("Total Cost", costQ, null, "up")
opsCard = AppStatCard("Requests", opsQ, null, "neutral")
agentsCard = AppStatCard("Active Agents", summaryQ, null, "neutral")
agentRows = Query("fetchUsageByAgent", ["", 1, 20], [], "data")
table = AppTable(agentRows, 20, "pages", true)
Here's your spend dashboard with top-level cost and operations KPIs plus an agent usage table — let me know if you'd like to add time-range filters, charts, or drill-down details!