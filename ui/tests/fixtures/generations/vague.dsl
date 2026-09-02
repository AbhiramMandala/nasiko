Sure — building that now.
root = AppStack([kpiRow, chart, table], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_cost_usd: 0, avg_latency_ms: null}, null)
historyQ = Query("fetchUsageHistory", [7], [])
agentQ = Query("fetchUsageByAgent", ["", 1, 20], [], "data")
kpiRow = AppRow([costCard, requestCard, latencyCard], "md")
costCard = AppStatCard("Total cost", "$" + @Round(summaryQ.total_cost_usd, 2), null, "neutral")
requestCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
latencyCard = AppStatCard("Avg latency", summaryQ.avg_latency_ms == null ? "—" : @Round(summaryQ.avg_latency_ms, 0) + "ms", null, "neutral")
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
table = AppTable(agentQ, 20, "pages", true)
Here's your cost overview — top KPIs, a 7-day trend, and agent breakdown with search. Let me know if you'd like to adjust the time window, add more metrics, or dive deeper into any agent!