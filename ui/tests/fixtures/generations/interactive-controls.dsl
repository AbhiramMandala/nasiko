Got it — building a cost dashboard with search and time-window controls for you.

root = AppStack([headerRow, kpiRow, chartSection, tableSection], "md")
$timeWindow = 7
$searchQuery = ""
headerRow = AppRow([title, spacer, sevenBtn, thirtyBtn], "md", "center")
title = AppStack(["Cost Dashboard"], "md")
spacer = AppStack([], "md")
sevenBtn = AppButton("7 days", $timeWindow == 7 ? "primary" : "secondary", "md", null, null, null, null, null, null, null, setWindowSeven)
thirtyBtn = AppButton("30 days", $timeWindow == 30 ? "primary" : "secondary", "md", null, null, null, null, null, null, null, setWindowThirty)
setWindowSeven = Action([@Set($timeWindow, 7), @Run(summaryQ), @Run(historyQ)])
setWindowThirty = Action([@Set($timeWindow, 30), @Run(summaryQ), @Run(historyQ)])
kpiRow = AppRow([costCard, opsCard, avgCostCard], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, avg_latency_ms: 0})
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
opsCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
avgCostCard = AppStatCard("Avg cost per request", summaryQ.avg_latency_ms, null, "neutral")
chartSection = AppStack([historyChart], "md")
historyQ = Query("fetchUsageHistory", [$timeWindow], [])
historyChart = AppChart({labels: historyQ.date, datasets: [{label: "Daily cost", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD")
tableSection = AppStack([searchRow, agentTable], "md")
searchRow = AppSearch("md", null, false, false, "Search agents...", $searchQuery, null, null, null, null, null, runSearch)
runSearch = Action([@Set($searchQuery, $event), @Run(agentQ)])
agentQ = Query("fetchUsageByAgent", [$searchQuery, 1, 20], [], "data")
agentTable = AppTable(agentQ, 20, "pages", true)

Here's your cost dashboard with KPI cards at the top, a 7/30-day toggle, a trend chart, and a searchable agent table below — let me know what adjustments you'd like!