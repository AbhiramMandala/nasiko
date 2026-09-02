Sure — building that now.
root = AppStack([headerRow, kpisRow, agentTable], "md")
$days = 7
$agentQuery = ""
headerRow = AppRow([titleCol, searchCol], "md", "center")
titleCol = AppStack([title], "xs")
title = AppStatCard("TokenOps Cost Dashboard", "", null, "neutral")
searchCol = AppSearch("md", null, false, false, "Search agents...", $agentQuery, null, null, null, null, null, updateSearch)
updateSearch = Action([@Set($agentQuery, $event), @Run(agentRows)])
kpisRow = AppRow([kpiCost, kpiOps, kpiAgents, rangeButtons], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
kpiCost = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "up")
kpiOps = AppStatCard("Requests", summaryQ.request_count, null, "neutral")
dashboardQ = Query("fetchTokenopsDashboard", [], {data: {summary: {total_agents: 0, active_agents: 0}}}, "data.summary")
kpiAgents = AppStatCard("Active agents", dashboardQ.active_agents, null, "neutral")
rangeButtons = AppRow([sevenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", $days == 7 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setSeven)
thirtyBtn = AppButton("30 days", $days == 30 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setThirty)
setSeven = Action([@Set($days, 7), @Run(agentRows)])
setThirty = Action([@Set($days, 30), @Run(agentRows)])
agentRows = Query("fetchUsageByAgent", [$agentQuery, 1, 20], [], "data")
agentTable = AppTable(agentRows, 20, "pages", true)

Here's your cost dashboard with KPI cards showing total cost, requests, and active agents, plus a search box for filtering agents and buttons to switch between 7-day and 30-day windows — let me know what else you'd like!