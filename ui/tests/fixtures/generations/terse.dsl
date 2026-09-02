Sure — building that now.
root = AppStack([kpis, agentTable], "md")
summaryQ = Query("fetchUsageSummary", [], 0)
dashboardQ = Query("fetchTokenopsDashboard", [], {data: {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0, total_agents: 0, total_container_hours: 0}, agents: [], token_usage: {}}})
kpis = AppRow([costCard, opsCard, agentsCard, containerCard], "md")
costCard = AppStatCard("Total cost", dashboardQ.data.summary.total_cost, null, "neutral")
opsCard = AppStatCard("Total operations", dashboardQ.data.summary.total_operations, null, "neutral")
agentsCard = AppStatCard("Active agents", dashboardQ.data.summary.active_agents, null, "neutral")
containerCard = AppStatCard("Container hours", dashboardQ.data.summary.total_container_hours, null, "neutral")
agentTable = AppTable(dashboardQ.data.agents, 20, "pages", true)
Here's your spend dashboard with top-level cost/ops KPIs and a paginated agent breakdown — let me know if you'd like to adjust the metrics, add filters, or change the table columns!