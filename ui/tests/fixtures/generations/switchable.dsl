Sure — building that now.
root = AppStack([toggleRow, kpiRow], "md")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Ops", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
kpiRow = AppRow([$view == "cost" ? costCard : opsCard], "md")
costCard = AppStatCard("Total Cost", "$" + @Round(summaryQ.total_cost_usd, 2), "neutral")
opsCard = AppStatCard("Total Requests", summaryQ.request_count, "neutral")
Here's your cost dashboard with a toggle between cost and operations views — let me know if you'd like to add more metrics or data details!