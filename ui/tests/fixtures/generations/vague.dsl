Sure — building that now.
root = AppStack([kpis, agentTable], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, avg_latency_ms: null})
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, active_agents: 0}, agents: []}, "data")
kpis = AppRow([costCard, opsCard, agentsCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral", false)
opsCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral", false)
agentsCard = AppStatCard("Active agents", dashboardQ.summary.active_agents, null, "neutral", false)
agentTable = AppTable(dashboardQ.agents, 20, "pages", false)
Here's your cost overview with top-line spending, request volume, agent count, and a breakdown table — let me know if you'd like to filter by time range or dive deeper into any agent!