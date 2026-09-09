Sure — building that now.
root = AppStack([headerRow, kpisRow, tableSection], "md")
$days = 7
$query = ""
headerRow = AppRow([titleText, searchBox], "md")
titleText = AppCard("cost-dashboard", "Cost Dashboard")
searchBox = AppSearch("md", null, false, false, "Search agents...", $query, null, null, null, null, null, updateSearch)
updateSearch = Action([@Set($query, $event), @Run(agentData)])
kpisRow = AppRow([rangeButtons, spacer], "md")
rangeButtons = AppRow([sevenDayBtn, thirtyDayBtn], "sm")
sevenDayBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, setSevenDays)
setSevenDays = Action([@Set($days, 7), @Run(summaryData), @Run(agentData)])
thirtyDayBtn = AppButton("30 days", "primary", null, null, null, null, null, null, null, null, setThirtyDays)
setThirtyDays = Action([@Set($days, 30), @Run(summaryData), @Run(agentData)])
spacer = AppRow([], "md")
summaryData = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, total_tokens: 0})
costKpi = AppStatCard("Total Cost", summaryData.total_cost_usd, null, "neutral")
requestKpi = AppStatCard("Requests", summaryData.request_count, null, "neutral")
tokenKpi = AppStatCard("Total Tokens", summaryData.total_tokens, null, "neutral")
kpiDisplay = AppRow([costKpi, requestKpi, tokenKpi], "md")
tableSection = AppStack([kpiDisplay, agentTable], "md")
agentData = Query("fetchUsageByAgent", [$query, 1, 20], [], "data")
agentTable = AppTable(agentData, 20, "pages", true)
Here's your cost dashboard with KPI cards, a search box, and time-window buttons — let me know if you'd like to add charts, adjust the layout, or change what columns show up!