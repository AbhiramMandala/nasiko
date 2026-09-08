Sure — building that now.

root = AppStack([header, controlRow, summaryCards, agentTable], "md")
$days = 7
$searchQuery = ""
header = AppText("Cost Dashboard", "title")
controlRow = AppRow([daysControl, searchBox], "md")
daysControl = AppRow([sevenDaysBtn, thirtyDaysBtn], "sm")
sevenDaysBtn = AppButton("7 days", $days == 7 ? "primary" : "secondary", null, null, null, null, null, null, null, null, selectSevenDays)
thirtyDaysBtn = AppButton("30 days", $days == 7 ? "secondary" : "primary", null, null, null, null, null, null, null, null, selectThirtyDays)
selectSevenDays = Action([@Set($days, 7), @Run(dashboardQ)])
selectThirtyDays = Action([@Set($days, 30), @Run(dashboardQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $searchQuery, null, null, null, null, null, updateSearch)
updateSearch = Action([@Set($searchQuery, $event), @Run(agentTableQ)])
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0, total_agents: 0, total_container_hours: 0}, agents: []}, "data")
summaryCards = AppRow([costCard, opsCard, agentsCard], "md")
costCard = AppStatCard("Total cost", dashboardQ.summary.total_cost, null, "neutral")
opsCard = AppStatCard("Operations", dashboardQ.summary.total_operations, null, "neutral")
agentsCard = AppStatCard("Active agents", dashboardQ.summary.active_agents, null, "neutral")
agentTableQ = Query("fetchUsageByAgent", [$searchQuery, 1, 50], [], "data")
agentTable = AppTable(agentTableQ, 50, "pages", true)

Here's your cost dashboard with a 7/30-day window toggle, search for agents, and KPI cards showing total cost, operations, and active agents — let me know if you'd like to adjust the layout, add more metrics, or change the time window defaults!