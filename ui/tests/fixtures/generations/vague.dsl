Sure — building that now.
root = AppStack([kpiRow, historyChart, agentTable], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_cost_usd: 0})
costKpi = AppStatCard("Total cost", "$" + @Round(summaryQ.total_cost_usd, 2), null, "neutral")
requestsKpi = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
kpiRow = AppRow([costKpi, requestsKpi], "md")
historyQ = Query("fetchUsageHistory", [7], [])
historyChart = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
agentRowsQ = Query("fetchUsageByAgent", ["", 1, 10], [], "data")
agentTable = AppTable(agentRowsQ, 10, "pages", false)
Here's your cost overview with KPIs, a 7-day trend chart, and the top agents by spend — let me know if you'd like to adjust the timeframe or drill into specific agents!