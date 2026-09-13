Sure — building that now.
root = AppStack([heading, controlsRow, kpiRow, agentTable], "md")
heading = AppText("Cost dashboard", "title")
$range = "7d"
$agentSearch = ""
controlsRow = AppRow([rangeControls, searchBox], "md")
rangeControls = AppRow([sevenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", $range == "7d" ? "primary" : "secondary", null, null, null, null, null, null, null, null, setSeven)
setSeven = Action([@Set($range, "7d"), @Run(dashboardQ)])
thirtyBtn = AppButton("30 days", $range == "30d" ? "primary" : "secondary", null, null, null, null, null, null, null, null, setThirty)
setThirty = Action([@Set($range, "30d"), @Run(dashboardQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $agentSearch, null, null, null, null, null, runSearch)
runSearch = Action([@Set($agentSearch, $event)])
dashboardQ = Query("fetchTokenopsDashboard", [{range: $range}], {kpis: {total_spend: {current: 0}}, attributions: {rows: []}}, "data")
kpiRow = AppStatRow([{label: "Total spend", value: dashboardQ.kpis.total_spend.current, sub: "USD", format: "currency"}, {label: "Total operations", value: dashboardQ.kpis.total_operations || 0}])
filteredAgents = @Filter(dashboardQ.attributions.rows, "agent_name", "contains", $agentSearch)
sortedAgents = @Sort(filteredAgents, "total_cost", "desc")
agentTable = AppTable(sortedAgents, 50, "pages", false, null, null, "No agents in this period")

Here's your cost dashboard with a time-range selector, search box, and agent cost table — let me know if you'd like to adjust the layout or add additional metrics!