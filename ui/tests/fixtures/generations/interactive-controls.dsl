Sure — building that now.
root = AppStack([header, controlRow, kpiRow, table], "md")
$days = 7
$query = ""
header = AppStack([title], "sm")
title = AppCard(null, "TokenOps Cost Dashboard")
controlRow = AppRow([searchBox, sevenBtn, thirtyBtn], "md")
searchBox = AppSearch("md", null, false, false, "Search agents...", $query, null, null, null, null, null, runSearch)
sevenBtn = AppButton("7 days", $days == 7 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setSeven)
thirtyBtn = AppButton("30 days", $days == 30 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setThirty)
setSeven = Action([@Set($days, 7), @Run(summaryQ)])
setThirty = Action([@Set($days, 30), @Run(summaryQ)])
runSearch = Action([@Set($query, $event), @Run(agentRows)])
summaryQ = Query("fetchTokenopsDashboard", [null, null], {total_cost: 0, total_operations: 0, active_agents: 0}, "data.summary")
kpiRow = AppStatRow([costCard, opsCard, agentsCard], false)
costCard = {label: "Total Cost", value: "$" + @Round(summaryQ.total_cost, 2), delta: null, trend: "neutral"}
opsCard = {label: "Operations", value: @Round(summaryQ.total_operations, 0), delta: null, trend: "neutral"}
agentsCard = {label: "Active Agents", value: summaryQ.active_agents, delta: null, trend: "neutral"}
agentRows = Query("fetchUsageByAgent", [$query, 1, 20], [], "data")
table = AppTable(agentRows, 20, "pages", true)
Here's your cost dashboard with KPIs, time-window toggles, agent search, and a paginated usage table — let me know if you'd like to adjust the metrics, add charts, or modify the layout!