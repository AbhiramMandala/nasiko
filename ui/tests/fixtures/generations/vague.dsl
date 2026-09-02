Sure — building that now.
root = AppStack([kpiRow, costChart, agentTable], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_cost_usd: 0}, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [7], [])
agentQ = Query("fetchUsageByAgent", ["", 1, 10], [], "data")
kpiRow = AppStatRow([costCard, requestCard], false)
costCard = {label: "Total cost", value: summaryQ, delta: null, trend: "neutral"}
requestCard = {label: "Requests", value: summaryQ, delta: null, trend: "neutral"}
costChart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
agentTable = AppTable(agentQ, 10, "pages", false)
Here's your cost overview — total spend, requests, a 7-day trend chart, and top agents by cost. Let me know if you'd like to filter by date range, drill into specific agents, or see other metrics!