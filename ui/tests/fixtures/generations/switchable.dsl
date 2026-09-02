Sure — building that now.
root = AppStack([toggleRow, kpiRow], "md")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Operations", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
kpiRow = AppRow([$view == "cost" ? costCard : opsCard], "md")
costCard = AppStatCard("Total cost", summaryQ.total_cost_usd, null, "neutral")
opsCard = AppStatCard("Total requests", summaryQ.request_count, null, "neutral")
Here's your cost/ops dashboard with toggle buttons — click to switch between total cost and request count. Let me know if you'd like to add more metrics, a time range picker, or a detail table!