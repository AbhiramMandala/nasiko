Sure — building that now.
root = AppStack([heading, controlsRow, kpisSection, agentTable], "md")
heading = AppText("Cost dashboard", "title")
$range = "7d"
$searchQuery = ""
controlsRow = AppRow([searchBox, rangeButtons], "md")
searchBox = AppSearch("md", null, false, false, "Search agents...", $searchQuery, null, null, null, null, null, handleSearch)
handleSearch = Action([@Set($searchQuery, $event), @Run(agentRows)])
rangeButtons = AppRow([btn24h, btn7d, btn30d], "sm")
btn24h = AppButton("24h", $range == "24h" ? "primary" : "secondary", null, null, null, null, null, null, null, null, select24h)
btn7d = AppButton("7d", $range == "7d" ? "primary" : "secondary", null, null, null, null, null, null, null, null, select7d)
btn30d = AppButton("30d", $range == "30d" ? "primary" : "secondary", null, null, null, null, null, null, null, null, select30d)
select24h = Action([@Set($range, "24h"), @Run(dashboardQ)])
select7d = Action([@Set($range, "7d"), @Run(dashboardQ)])
select30d = Action([@Set($range, "30d"), @Run(dashboardQ)])
kpisSection = AppStack([kpiHeading, kpis], "xs")
kpiHeading = AppText("Summary", "subtitle")
dashboardQ = Query("fetchTokenopsDashboard", [{range: $range}], {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}, avg_latency_ms: {current: null, previous: null, change_pct: null}}, attributions: {rows: []}, agents: []}, "data.kpis")
kpis = AppStatRow([{label: "Total spend", value: dashboardQ.total_spend.current, sub: "USD", delta: dashboardQ.total_spend.current - dashboardQ.total_spend.previous, trend: dashboardQ.total_spend.change_pct != null ? (dashboardQ.total_spend.change_pct > 0 ? "up" : dashboardQ.total_spend.change_pct < 0 ? "down" : "neutral") : "neutral"}, {label: "Total tokens", value: dashboardQ.total_tokens.current, delta: dashboardQ.total_tokens.current - dashboardQ.total_tokens.previous, trend: dashboardQ.total_tokens.change_pct != null ? (dashboardQ.total_tokens.change_pct > 0 ? "up" : dashboardQ.total_tokens.change_pct < 0 ? "down" : "neutral") : "neutral"}, {label: "Cost per op", value: @Round(dashboardQ.cost_per_operation.current, 4), delta: @Round(dashboardQ.cost_per_operation.current - dashboardQ.cost_per_operation.previous, 4), trend: dashboardQ.cost_per_operation.change_pct != null ? (dashboardQ.cost_per_operation.change_pct > 0 ? "up" : dashboardQ.cost_per_operation.change_pct < 0 ? "down" : "neutral") : "neutral"}])
agentTable = AppTable(agentRows, 20, "pages", true)
agentRows = Query("fetchTokenopsDashboard", [{range: $range}], {attributions: {rows: []}}, "data.attributions.rows")

Here's your cost dashboard with KPI summaries, a time-window selector, and a searchable agent table — let me know if you'd like to adjust the layout, add filters, or change what metrics are displayed!