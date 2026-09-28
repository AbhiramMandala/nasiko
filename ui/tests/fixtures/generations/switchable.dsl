Sure — building that now.
root = AppStack([heading, viewPicker, kpis, spendChart], "md")
heading = AppText("TokenOps dashboard", "title")
$view = "cost"
viewPicker = AppSegmentedControl([{value: "cost", label: "Cost"}, {value: "ops", label: "Operations"}], $view, "md", false, null, "View", null, switchView)
switchView = Action([@Set($view, $event)])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0}, null)
historyQ = Query("fetchUsageHistory", [7], [], null)
costKpi = AppStatCard("Total spend", summaryQ.total_cost_usd, null, "neutral", false, "currency", "USD")
opsKpi = AppStatCard("Total operations", summaryQ.request_count, null, "neutral", false, "compact")
kpis = $view == "cost" ? costKpi : opsKpi
spendChart = $view == "cost" ? AppChart({labels: historyQ.date, datasets: [{label: "Spend (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data available") : AppChart({labels: historyQ.date, datasets: [{label: "Operations", data: historyQ.request_count}]}, "line", false, "compact", null, null, null, "auto", "No operations data available")

Here's your cost dashboard with a view toggle between spend and operations — each showing its own KPI and trend chart. Let me know if you'd like to adjust the time range, add more detail, or change the layout!