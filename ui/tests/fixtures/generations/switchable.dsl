Sure — building that now.
root = AppStack([toggleRow, kpis], "md")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Ops", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
dashboardQ = Query("fetchTokenopsDashboard", [{}], {data: {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}}, summary: {total_cost: 0, total_operations: 0}}})
costLabel = "Total spend"
costValue = dashboardQ.data.kpis.total_spend.current
costDelta = dashboardQ.data.kpis.total_spend.change_pct
opsLabel = "Total operations"
opsValue = dashboardQ.data.kpis.total_tokens.current
opsDelta = dashboardQ.data.kpis.total_tokens.change_pct
trend = costDelta > 0 ? "up" : costDelta < 0 ? "down" : "neutral"
kpis = AppStatCard($view == "cost" ? costLabel : opsLabel, $view == "cost" ? costValue : opsValue, $view == "cost" ? costDelta : opsDelta, trend, false, $view == "cost" ? "currency" : "number", "USD")
Here's your cost dashboard with a toggle between spend and operations — click either button to switch views!