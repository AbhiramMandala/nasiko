Sure — building that now.
root = AppStack([heading, controls, costCards, agentTable], "md")
heading = AppText("Cost dashboard", "title")
$days = 7
$searchQuery = ""
controls = AppRow([rangeControls, searchBox], "md")
rangeControls = AppRow([sevenBtn, thirtyBtn, ninetyBtn], "sm")
sevenBtn = AppButton("7 days", $days == 7 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setSeven)
thirtyBtn = AppButton("30 days", $days == 30 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setThirty)
ninetyBtn = AppButton("90 days", $days == 90 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setNinety)
setSeven = Action([@Set($days, 7), @Run(summaryQ), @Run(historyQ), @Run(agentQ)])
setThirty = Action([@Set($days, 30), @Run(summaryQ), @Run(historyQ), @Run(agentQ)])
setNinety = Action([@Set($days, 90), @Run(summaryQ), @Run(historyQ), @Run(agentQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $searchQuery, null, null, null, null, null, runSearch)
runSearch = Action([@Set($searchQuery, $event), @Run(agentQ)])
summaryQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
historyQ = Query("fetchUsageHistory", [$days], [])
costCards = AppStatCard("Total cost", summaryQ, null, "neutral")
agentQ = Query("fetchUsageByAgent", [$searchQuery, 1, 50], [], "data")
agentTable = AppTable(agentQ, 50, "pages", false)

Here's your cost dashboard with a 7/30/90-day window switcher, search filter for agents, and a cost summary with a detailed agent breakdown table — let me know if you'd like to adjust the layout or add more metrics!