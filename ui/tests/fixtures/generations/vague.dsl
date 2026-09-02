Sure — building that now.
root = AppStack([kpis, chart, table], "md")
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
requestCountQ = Query("fetchUsageSummary", [], 0, "request_count")
avgCostQ = Query("fetchUsageSummary", [], 0, "avg_latency_ms")
historyRows = Query("fetchUsageHistory", [7], [])
kpis = AppRow([costCard, requestCard, avgCard], "md")
costCard = AppStatCard("Total cost", totalCostQ, null, "neutral")
requestCard = AppStatCard("Requests", requestCountQ, null, "neutral")
avgCard = AppStatCard("Avg latency", avgCostQ, null, "neutral")
chart = AppChart({labels: historyRows.date, datasets: [{label: "Cost", data: historyRows.total_cost_usd}]}, "line", false, "currency", "USD")
agentRows = Query("fetchUsageByAgent", ["", 1, 50], [], "data")
table = AppTable(agentRows, 50, "pages", true)
Here's your cost overview with top-level KPIs, a 7-day cost trend, and a breakdown by agent — let me know if you'd like to adjust the timeframe, add more metrics, or dive deeper into any specific area!