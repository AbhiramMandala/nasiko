Sure — building that now.
root = AppStack([toggleRow, kpiRow], "md")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Operations", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
costKpi = AppStatCard("Total cost", $view == "cost" ? summaryQ.total_cost_usd : null, null, "up")
opsKpi = AppStatCard("Total requests", $view == "ops" ? summaryQ.request_count : null, null, "neutral")
kpiRow = AppRow([$view == "cost" ? costKpi : opsKpi], "md")
Here's your cost/ops toggle dashboard with KPIs that switch between cost and request count — let me know if you'd like to add trends, historical views, or drill-down tables!