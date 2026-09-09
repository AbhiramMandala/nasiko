Sure — building that now.
root = AppStack([heading, toggleRow, kpiRow], "md")
heading = AppText("Fleet overview", "title")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Ops", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
kpiRow = AppStatRow([$view == "cost" ? {label: "Total cost", value: summaryQ.total_cost_usd, sub: "all time"} : {label: "Requests", value: summaryQ.request_count}], false)
Here's your cost/ops dashboard with toggle buttons to switch views — let me know if you'd like to add breakdown tables or charts!