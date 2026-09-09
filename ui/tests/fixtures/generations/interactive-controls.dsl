Sure — building that now.
root = AppStack([heading, controls, kpis, table], "md")
heading = AppText("Cost dashboard", "title")
$range = "7d"
$search = ""
controls = AppRow([rangeGroup, searchBox], "md")
rangeGroup = AppSegmentedControl([{label: "24h", value: "24h"}, {label: "7d", value: "7d"}, {label: "30d", value: "30d"}], $range, "md", false, null, null, "Time window", setRange)
setRange = Action([@Set($range, $event), @Run(dashboardQ)])
searchBox = AppSearch("md", null, false, false, "Search by agent or model...", $search, null, null, null, null, null, runSearch)
runSearch = Action([@Set($search, $event), @Run(dashboardQ)])
dashboardQ = Query("fetchTokenopsDashboard", [{range: $range}], {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}, avg_latency_ms: {current: null, previous: null, change_pct: null}}, attributions: {rows: []}}, "data")
kpis = AppStatRow([{label: "Total spend", value: @Round(dashboardQ.kpis.total_spend.current, 2), sub: "USD", delta: @Round(dashboardQ.kpis.total_spend.change_pct, 1), trend: dashboardQ.kpis.total_spend.change_pct > 0 ? "up" : dashboardQ.kpis.total_spend.change_pct < 0 ? "down" : "neutral"}, {label: "Total tokens", value: @Round(dashboardQ.kpis.total_tokens.current, 0), delta: @Round(dashboardQ.kpis.total_tokens.change_pct, 1), trend: dashboardQ.kpis.total_tokens.change_pct > 0 ? "up" : dashboardQ.kpis.total_tokens.change_pct < 0 ? "down" : "neutral"}, {label: "Cost per op", value: @Round(dashboardQ.kpis.cost_per_operation.current, 4), sub: "USD", delta: @Round(dashboardQ.kpis.cost_per_operation.change_pct, 1), trend: dashboardQ.kpis.cost_per_operation.change_pct > 0 ? "up" : dashboardQ.kpis.cost_per_operation.change_pct < 0 ? "down" : "neutral"}])
table = AppTable(dashboardQ.attributions.rows, 20, "pages", false)
Here's your cost dashboard with a time-window selector, search box, KPI strip, and agent/attribution table — let me know if you'd like to adjust the metrics, add filters, or change the layout!