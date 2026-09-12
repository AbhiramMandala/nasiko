Sure — building that now.
root = AppStack([heading, controlRow, kpis, table], "md")
heading = AppText("Cost dashboard", "title")
$days = 7
$agentSearch = ""
controlRow = AppRow([sevenBtn, thirtyBtn, searchBox], "md")
sevenBtn = AppButton("7 days", $days == 7 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setSeven)
thirtyBtn = AppButton("30 days", $days == 30 ? "primary" : "secondary", null, null, null, null, null, null, null, null, setThirty)
setSeven = Action([@Set($days, 7), @Run(dashboardQ)])
setThirty = Action([@Set($days, 30), @Run(dashboardQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $agentSearch, null, null, null, null, null, runSearch)
runSearch = Action([@Set($agentSearch, $event)])
dashboardQ = Query("fetchTokenopsDashboard", [{range: $days == 7 ? "7d" : "30d"}], {kpis: {total_spend: {current: 0}}}, "data.kpis")
filteredAgents = @Filter(Query("fetchTokenopsDashboard", [{range: $days == 7 ? "7d" : "30d"}], {agents: []}, "data.agents"), "agent_name", "contains", $agentSearch)
kpis = AppStatCard("Total spend", dashboardQ.total_spend.current, null, "neutral", false, "currency", "USD")
table = AppTable(@Sort(filteredAgents, "total_cost", "desc"), 50, "pages", false, null, null, "No agents found for this search", false)

Here's your cost dashboard with a 7/30-day window toggle, search box, top-line spend metric, and searchable agent cost table — let me know if you'd like to adjust the layout or add more metrics!