Sure — building that now.

root = AppStack([toggleRow, kpis, agentBreakdown], "md")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Ops", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, total_tokens: 0, avg_latency_ms: null})
kpis = AppStatRow([$view == "cost" ? {label: "Total cost", value: summaryQ.total_cost_usd, sub: "all time", format: "currency"} : {label: "Total requests", value: summaryQ.request_count, sub: "all time"}, $view == "cost" ? {label: "Avg cost per request", value: summaryQ.total_cost_usd / summaryQ.request_count, format: "currency"} : {label: "Total tokens", value: summaryQ.total_tokens, format: "compact"}])
agentQ = Query("fetchUsageByAgent", ["", 1, 50], {data: []}, "data")
agentBreakdown = AppStack([$view == "cost" ? costTitle : opsTitle, $view == "cost" ? costTable : opsTable], "md")
costTitle = AppText("Cost by agent", "title")
opsTitle = AppText("Operations by agent", "title")
costTable = AppTable(@Sort(agentQ, "total_cost_usd", "desc"), 50, "pages", false, null, null, "No agents found")
opsTable = AppTable(@Sort(agentQ, "request_count", "desc"), 50, "pages", false, null, null, "No agents found")

Here's your cost dashboard with toggle between cost and operations views — it shows summary KPIs and a per-agent breakdown that sorts by whichever metric you're looking at. Let me know if you'd like to adjust the metrics, add filters, or change the layout!