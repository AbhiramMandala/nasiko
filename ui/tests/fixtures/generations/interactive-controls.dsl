Sure — building that now.

root = AppStack([header, controlRow, statsSection, agentTable], "md")
header = AppText("Cost dashboard", "title")
$dateWindow = 7
$searchQuery = ""
controlRow = AppRow([searchBox, sevenDayBtn, thirtyDayBtn], "md")
searchBox = AppSearch("md", null, false, false, "Search agents...", $searchQuery, null, null, null, null, null, updateSearch)
updateSearch = Action([@Set($searchQuery, $event), @Run(agentData)])
sevenDayBtn = AppButton("7 days", $dateWindow == 7 ? "primary" : "secondary", null, null, null, null, null, null, null, null, selectSeven)
thirtyDayBtn = AppButton("30 days", $dateWindow == 30 ? "primary" : "secondary", null, null, null, null, null, null, null, null, selectThirty)
selectSeven = Action([@Set($dateWindow, 7), @Run(dashboardData)])
selectThirty = Action([@Set($dateWindow, 30), @Run(dashboardData)])
dashboardData = Query("fetchTokenopsDashboard", null, {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0, total_agents: 0, total_container_hours: 0}, agents: [], token_usage: {}})
statsSection = AppStatRow([{label: "Total cost", value: "$" + @Round(dashboardData.summary.total_cost, 2), sub: "all time"}, {label: "Total operations", value: dashboardData.summary.total_operations}, {label: "Last 24h ops", value: dashboardData.summary.operations_last_24h}, {label: "Active agents", value: dashboardData.summary.active_agents}])
agentData = Query("fetchUsageByAgent", [$searchQuery, 1, 50], [], "data")
agentTable = AppTable(agentData, 50, "pages", true)

Here's your cost dashboard with time-window buttons, agent search, KPI stats, and a paginated table — let me know if you'd like to adjust the metrics, add a chart, or refine the layout!