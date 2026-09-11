Sure — building that now.

root = AppStack([heading, kpis, trendChart, agentTable], "md")
heading = AppText("Cost overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [7], [])
kpis = AppStatCard("Total cost", summaryQ, null, "neutral", false, "currency", "USD")
trendChart = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend in the last 7 days")
agentRows = Query("fetchUsageByAgent", [null, 1, 20], [], "data")
agentTable = AppTable(agentRows, 20, "pages", true, "Search agents...", null, null, "No agents have run yet")

Here's your cost dashboard with a headline metric, a 7-day trend, and a breakdown by agent — let me know if you'd like to adjust the time window, add more metrics, or drill into any of them!