Sure — building that now.

root = AppStack([heading, kpis, rangeRow, table], "md")
heading = AppText("Spend overview", "title")
$range = "7d"
rangeRow = AppRow([sevenBtn, thirtyBtn], "sm")
sevenBtn = AppButton("7 days", "secondary", null, null, null, null, null, null, null, null, showSeven)
thirtyBtn = AppButton("30 days", "primary", null, null, null, null, null, null, null, null, showThirty)
showSeven = Action([@Set($range, "7d"), @Run(dashboardQ)])
showThirty = Action([@Set($range, "30d"), @Run(dashboardQ)])
dashboardQ = Query("fetchTokenopsDashboard", [{range: $range}], {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}, avg_latency_ms: {current: null, previous: null, change_pct: null}}, attributions: {rows: []}}, "data")
kpis = AppStatRow([{label: "Total spend", value: "$" + @Round(dashboardQ.kpis.total_spend.current, 2), delta: dashboardQ.kpis.total_spend.change_pct, trend: dashboardQ.kpis.total_spend.change_pct > 0 ? "up" : dashboardQ.kpis.total_spend.change_pct < 0 ? "down" : "neutral"}, {label: "Total tokens", value: @Round(dashboardQ.kpis.total_tokens.current, 0), delta: dashboardQ.kpis.total_tokens.change_pct, trend: dashboardQ.kpis.total_tokens.change_pct > 0 ? "up" : dashboardQ.kpis.total_tokens.change_pct < 0 ? "down" : "neutral"}, {label: "Cost per operation", value: "$" + @Round(dashboardQ.kpis.cost_per_operation.current, 4)}])
table = AppTable(dashboardQ.attributions.rows, 20, "pages", false)

Here's your spend dashboard with KPIs and a table of agent attributions — let me know if you'd like to adjust the time range options, add charts, or dig into specific agents!