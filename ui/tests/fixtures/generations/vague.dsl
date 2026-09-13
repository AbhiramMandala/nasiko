Sure — building that now.

root = AppStack([heading, kpis, agentTable], "md")
heading = AppText("Cost overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [7], [])
costChange = @Last(historyQ.total_cost_usd) - @First(historyQ.total_cost_usd)
costTrend = costChange > 0 ? "up" : costChange < 0 ? "down" : "neutral"
kpis = AppStatCard("Total cost", summaryQ, @Round(costChange, 2), costTrend, false, "currency", "USD")
agentRows = Query("fetchUsageByAgent", ["", 1, 10], [], "data")
agentTable = AppTable(agentRows, 10, "pages", false, "", false, "No agents have incurred costs yet")

Here's your cost overview with the all-time total, a 7-day trend, and the top agents by spend — let me know if you'd like to break it down differently or add more detail!