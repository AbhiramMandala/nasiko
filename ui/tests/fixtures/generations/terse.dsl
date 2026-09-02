Sure — building that now.
root = AppStack([kpis, agentTable], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_cost_usd: 0, avg_latency_ms: 0}, null)
kpis = AppRow([costCard, requestCard, latencyCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
requestCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
latencyCard = AppStatCard("Avg latency", summaryQ.avg_latency_ms, null, "neutral")
agentRows = Query("fetchUsageByAgent", ["", 1, 50], [], "data")
agentTable = AppTable(agentRows, 50, "pages", true)
Here's your spend dashboard with top-level cost and request KPIs plus a paginated table of usage by agent — let me know if you'd like to add filters, date ranges, or drill into other dimensions!