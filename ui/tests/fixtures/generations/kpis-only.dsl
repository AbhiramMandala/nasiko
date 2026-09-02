Sure — building that now.
root = AppStack([kpis], "md")
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, active_agents: 0}}, "data.summary")
kpis = AppRow([costCard, opsCard, ops24hCard, agentsCard], "md")
costCard = AppStatCard("Total cost", dashboardQ.total_cost, null, "neutral")
opsCard = AppStatCard("Total operations", dashboardQ.total_operations, null, "neutral")
ops24hCard = AppStatCard("Ops (24h)", dashboardQ.operations_last_24h, null, "neutral")
agentsCard = AppStatCard("Active agents", dashboardQ.active_agents, null, "neutral")
Here's your headline dashboard with total cost, operations, 24-hour ops, and active agent count — let me know if you'd like to adjust the metrics or add anything else!