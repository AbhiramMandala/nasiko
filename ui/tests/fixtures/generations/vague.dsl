Sure — building that now.

root = AppStack([heading, kpis, spendChart], "md")
heading = AppText("Cost overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [7], [])
spendTrend = @Last(historyQ) && @First(historyQ) ? @Last(historyQ).total_cost_usd > @First(historyQ).total_cost_usd ? "up" : "down" : "neutral"
kpis = AppStatCard("Total cost (30 days)", summaryQ, null, spendTrend)
spendChart = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend in the last 7 days")

Here's your cost overview with a 30-day total and a 7-day trend chart — let me know if you'd like to break it down by agent, model, or anything else!