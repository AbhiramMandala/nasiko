Sure — building that now.
root = AppStack([kpis, chart, table], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, active_agents: 0}, agents: []})
kpis = AppRow([costCard, opsCard, agentsCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, "neutral")
opsCard = AppStatCard("Requests", summaryQ.request_count, "neutral")
agentsCard = AppStatCard("Active agents", dashboardQ.summary.active_agents, "neutral")
historyQ = Query("fetchUsageHistory", [7], [])
chart = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
agentRows = Query("fetchUsageByAgent", [null, 1, 20], [], "data")
table = AppTable(agentRows, 20, "pages", true)
Here's your cost dashboard with overall spend KPIs, a 7-day trend chart, and a breakdown by agent — let me know if you'd like to adjust the time range, add more metrics, or drill into specific agents!