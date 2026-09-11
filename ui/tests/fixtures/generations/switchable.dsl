Sure — building that now.
root = AppStack([toggleRow, kpis, agentTable], "md")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Ops", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, null)
costKpi = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral", false, "currency", "USD")
opsKpi = AppStatCard("Total requests", summaryQ.request_count, null, "neutral", false, "number", null)
kpis = $view == "cost" ? costKpi : opsKpi
agentRows = Query("fetchUsageByAgent", ["", 1, 50], [], "data")
agentTable = AppTable(agentRows, 50, "pages", false)
Here's your cost/ops dashboard with toggle buttons and a summary metric that switches between total spend and request count — let me know if you'd like to add more detail like a breakdown chart or filter by agent!