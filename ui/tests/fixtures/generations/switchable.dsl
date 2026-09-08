Sure — building that now.

root = AppStack([heading, toggleRow, kpis, agentTable], "md")
heading = AppText("TokenOps Dashboard", "title")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Operations", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, total_tokens: 0})
costMetric = {label: "Total cost", value: "$" + @Round(summaryQ.total_cost_usd, 2), sub: "all time"}
opsMetrics = [{label: "Requests", value: summaryQ.request_count}, {label: "Tokens", value: summaryQ.total_tokens}]
kpis = AppStatRow($view == "cost" ? [costMetric] : opsMetrics)
agentRows = Query("fetchUsageByAgent", ["", 1, 50], [], "data")
agentTable = AppTable(agentRows, 50, "pages", true)

Here's your cost/ops dashboard with a toggle to switch views and a summary row that updates based on your selection — let me know if you'd like to adjust the metrics, add charts, or change anything else!