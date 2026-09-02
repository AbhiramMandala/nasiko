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
costCard = AppStatCard("Total cost", "$" + @Round(summaryQ.total_cost_usd, 2), null, "up")
opsCard = AppStatCard("Total requests", summaryQ.request_count, null, "neutral")
Here's your cost dashboard with toggle buttons to switch between cost and operations views — let me know if you'd like to add a history chart or agent breakdown!