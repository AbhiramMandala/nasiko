Sure — building that now.
root = AppStack([heading, toggleRow, kpis], "md")
heading = AppText("TokenOps Dashboard", "title")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Ops", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, avg_latency_ms: 0})
costLabel = $view == "cost" ? "Total cost" : "Total requests"
costValue = $view == "cost" ? summaryQ.total_cost_usd : summaryQ.request_count
latencyValue = summaryQ.avg_latency_ms
kpis = AppStatRow([{label: costLabel, value: costValue, sub: "all time"}, {label: "Avg latency", value: latencyValue, sub: "milliseconds"}])
Here's your cost/ops dashboard with a toggle between views — let me know if you'd like to add more metrics, a historical chart, or agent-level detail!