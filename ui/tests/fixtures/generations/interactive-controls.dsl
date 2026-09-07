Sure — building that now.
root = AppStack([headerRow, kpisRow, tableSection], "md")
$days = 7
$agentQuery = ""
headerRow = AppRow([title, rangeControls], "md", "center", "between")
title = AppCard(null, "TokenOps Cost Dashboard", null, null, null, null, null, null, null, null, null, null, null, false)
rangeControls = AppRow([sevenBtn, thirtyBtn, ninetyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, loadSeven)
thirtyBtn = AppButton("30 days", "primary", null, null, null, null, null, null, null, null, loadThirty)
ninetyBtn = AppButton("90 days", "secondary", null, null, null, null, null, null, null, null, loadNinety)
loadSeven = Action([@Set($days, 7), @Run(summaryQ)])
loadThirty = Action([@Set($days, 30), @Run(summaryQ)])
loadNinety = Action([@Set($days, 90), @Run(summaryQ)])
kpisRow = AppRow([costCard, opsCard, avgCard], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, avg_latency_ms: 0})
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral", false)
opsCard = AppStatCard("Requests", summaryQ.request_count, null, "neutral", false)
avgCard = AppStatCard("Avg latency", summaryQ.avg_latency_ms, null, "neutral", false)
tableSection = AppStack([searchBox, agentTable], "md")
searchBox = AppSearch("md", null, false, false, "Search agents...", $agentQuery, null, null, null, null, null, runSearch)
runSearch = Action([@Set($agentQuery, $event), @Run(agentRowsQ)])
agentRowsQ = Query("fetchUsageByAgent", [$agentQuery, 1, 50], [], "data")
agentTable = AppTable(agentRowsQ, 50, "pages", true, "Search by agent name...", null, "No agents found")
Here's your cost dashboard with time-window buttons (7/30/90 days), summary KPIs, and a searchable agent usage table — let me know if you'd like to adjust the layout, add charts, or filter by additional fields!