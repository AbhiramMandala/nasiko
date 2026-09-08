Sure — building that now.

root = AppStack([heading, controls, kpis, agentTable], "md")
heading = AppText("Cost dashboard", "title")
$days = 7
$agentQuery = ""
controls = AppRow([rangeRow, searchBox], "md", "center", "between")
rangeRow = AppRow([sevenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, showSeven)
thirtyBtn = AppButton("30 days", "primary", null, null, null, null, null, null, null, null, showThirty)
showSeven = Action([@Set($days, 7), @Run(summaryQ), @Run(historyQ)])
showThirty = Action([@Set($days, 30), @Run(summaryQ), @Run(historyQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $agentQuery, null, null, null, null, null, runSearch)
runSearch = Action([@Set($agentQuery, $event), @Run(agentRowsQ)])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, total_tokens: 0}, null)
historyQ = Query("fetchUsageHistory", [$days], [])
kpis = AppStatRow([{label: "Total cost", value: summaryQ.total_cost_usd, sub: "USD"}, {label: "Requests", value: summaryQ.request_count}, {label: "Total tokens", value: summaryQ.total_tokens}])
agentRowsQ = Query("fetchUsageByAgent", [$agentQuery, 1, 50], [], "data")
agentTable = AppTable(agentRowsQ, 50, "pages", true)

Here's your cost dashboard with summary KPIs at the top, a time-window toggle, agent search, and a paginated table showing per-agent usage — let me know if you'd like to add a chart, adjust the layout, or change any of the metrics!