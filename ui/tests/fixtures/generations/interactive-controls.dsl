Sure — building a cost dashboard with search, time window controls, and real cost data for you.

root = AppStack([heading, controlRow, costCards, agentTable], "md")
heading = AppText("Cost dashboard", "title")
$days = 7
$searchQuery = ""
controlRow = AppRow([rangeButtonRow, searchBox], "md", "center")
rangeButtonRow = AppRow([sevenDayBtn, thirtyDayBtn], "sm")
sevenDayBtn = AppButton("7 days", $days == 7 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setSeven)
thirtyDayBtn = AppButton("30 days", $days == 30 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setThirty)
setSeven = Action([@Set($days, 7), @Run(summaryQ), @Run(historyQ), @Run(agentQ)])
setThirty = Action([@Set($days, 30), @Run(summaryQ), @Run(historyQ), @Run(agentQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $searchQuery, null, null, null, null, null, runSearch)
runSearch = Action([@Set($searchQuery, $event), @Run(agentQ)])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [$days], [])
agentQ = Query("fetchUsageByAgent", [$searchQuery, 1, 50], [], "data")
costCards = AppStatRow([{label: "Total cost", value: summaryQ, sub: $days == 7 ? "last 7 days" : "last 30 days"}, {label: "Requests", value: summaryQ, sub: "total"}])
agentTable = AppTable(agentQ, 50, "pages", true)

Here's your cost dashboard with KPI cards, time window buttons (7 and 30 days), a search box for agents, and a paginated table of agent costs — let me know if you'd like to adjust the layout, add a chart, or refine the metrics!