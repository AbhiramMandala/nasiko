Sure — building that now.
root = AppStack([heading, toggleRow, kpiSection, attributionsSection], "md")
heading = AppText("FinOps Dashboard", "title")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Ops", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
dashboardQ = Query("fetchTokenopsDashboard", [{range: "7d"}], {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}}, attributions: {rows: []}})
kpiSection = AppStack([$view == "cost" ? costKpis : opsKpis], "md")
costKpis = AppStatRow([{label: "Total spend", value: "$" + @Round(dashboardQ.kpis.total_spend.current, 2), delta: @Round(dashboardQ.kpis.total_spend.change_pct, 1) + "%", trend: dashboardQ.kpis.total_spend.change_pct > 0 ? "up" : dashboardQ.kpis.total_spend.change_pct < 0 ? "down" : "neutral"}, {label: "Cost per operation", value: "$" + @Round(dashboardQ.kpis.cost_per_operation.current, 4), delta: @Round(dashboardQ.kpis.cost_per_operation.change_pct, 1) + "%", trend: dashboardQ.kpis.cost_per_operation.change_pct > 0 ? "up" : dashboardQ.kpis.cost_per_operation.change_pct < 0 ? "down" : "neutral"}])
opsKpis = AppStatRow([{label: "Total tokens", value: @Round(dashboardQ.kpis.total_tokens.current, 0), delta: @Round(dashboardQ.kpis.total_tokens.change_pct, 1) + "%", trend: dashboardQ.kpis.total_tokens.change_pct > 0 ? "up" : dashboardQ.kpis.total_tokens.change_pct < 0 ? "down" : "neutral"}, {label: "Avg latency", value: dashboardQ.kpis.avg_latency_ms.current ? @Round(dashboardQ.kpis.avg_latency_ms.current, 0) + "ms" : "—", delta: dashboardQ.kpis.avg_latency_ms.change_pct ? @Round(dashboardQ.kpis.avg_latency_ms.change_pct, 1) + "%" : null, trend: dashboardQ.kpis.avg_latency_ms.change_pct ? (dashboardQ.kpis.avg_latency_ms.change_pct > 0 ? "down" : dashboardQ.kpis.avg_latency_ms.change_pct < 0 ? "up" : "neutral") : "neutral"}])
attributionsSection = AppStack([attributionsHeading, attributionsTable], "md")
attributionsHeading = AppText($view == "cost" ? "Spend by agent" : "Operations by agent", "subtitle")
attributionsTable = AppTable($view == "cost" ? costAttributions : opsAttributions, 20, "pages", false)
costAttributions = Query("fetchTokenopsDashboard", [{range: "7d", view: "agent"}], [], "data.attributions.rows")
opsAttributions = Query("fetchTokenopsDashboard", [{range: "7d", view: "agent"}], [], "data.attributions.rows")
Here's your cost and operations dashboard with a toggle, KPIs with trends, and an agent breakdown table — let me know if you'd like to adjust the time range, add charts, or dive deeper into specific metrics!