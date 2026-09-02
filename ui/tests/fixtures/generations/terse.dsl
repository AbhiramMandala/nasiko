Sure — building that now.

root = AppStack([kpis, agentTable], "md")
summaryQ = Query("fetchUsageSummary", [], 0)
totalCostCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
requestCountCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
avgLatencyCard = AppStatCard("Avg latency", summaryQ.avg_latency_ms, null, "neutral")
kpis = AppRow([totalCostCard, requestCountCard, avgLatencyCard], "md")
agentRows = Query("fetchUsageByAgent", ["", 1, 50], [], "data")
agentTable = AppTable(agentRows, 50, "pages", false)

Here's your spend dashboard with top-line KPIs (total cost, requests, latency) and an agent usage table — let me know if you'd like to add charts, filters, or drill-down detail!