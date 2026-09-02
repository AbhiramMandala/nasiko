Sure — building that now.
root = AppStack([kpis], "md")
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0}}, "data.summary")
kpis = AppRow([costCard, opsCard, opsCard24h, avgCostCard, activeAgentsCard], "md")
costCard = AppStatCard("Total cost", dashboardQ.total_cost, null, "neutral")
opsCard = AppStatCard("Total operations", dashboardQ.total_operations, null, "neutral")
opsCard24h = AppStatCard("Operations (24h)", dashboardQ.operations_last_24h, null, "neutral")
avgCostCard = AppStatCard("Average cost", dashboardQ.average_cost, null, "neutral")
activeAgentsCard = AppStatCard("Active agents", dashboardQ.active_agents, null, "neutral")
Here's your dashboard with five headline KPIs — total cost, operations, 24-hour ops, average cost, and active agent count. Let me know if you'd like to adjust which metrics appear!