Sure — building that now.

root = AppStack([heading, kpis, breakdown], "md")
heading = AppText("Cost overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [7], [])
costTrend = @Last(historyQ.total_cost_usd) - @First(historyQ.total_cost_usd)
costDirection = costTrend > 0 ? "up" : costTrend < 0 ? "down" : "neutral"
kpis = AppStatCard("Total cost", summaryQ, costTrend > 0 ? "+" + @Round(costTrend, 2) : @Round(costTrend, 2), costDirection, false, "currency", "USD")
breakdown = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "off", "No cost data for the last 7 days")

Here's your cost overview with a 7-day trend and a daily cost chart — let me know if you'd like to see it by agent, by model, or adjust the time window!