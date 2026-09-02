Sure — building that now.
root = AppStack([kpis, chart, table], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, total_tokens: 0})
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0}, agents: []})
kpis = AppRow([costCard, opsCard, agentsCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
opsCard = AppStatCard("Total requests", summaryQ.request_count, null, "neutral")
agentsCard = AppStatCard("Active agents", dashboardQ.summary.active_agents, null, "neutral")
historyQ = Query("fetchUsageHistory", [7], [])
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
agentRows = Query("fetchUsageByAgent", ["", 1, 20], [], "data")
table = AppTable(agentRows, 20, "pages", true)
Here's your cost overview with top-line KPIs, a 7-day cost trend, and a breakdown by agent — let me know if you'd like to adjust the timeframe, add more detail, or focus on a specific metric!