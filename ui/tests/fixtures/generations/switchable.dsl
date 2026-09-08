Sure — building that now.

root = AppStack([heading, toggleRow, metrics], "md")
heading = AppText("Cost & Operations Dashboard", "title")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Operations", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, total_tokens: 0, avg_latency_ms: null})
metrics = $view == "cost" ? AppStatRow([{label: "Total cost", value: summaryQ.total_cost_usd, sub: "all time"}, {label: "Avg cost per request", value: @Round(summaryQ.total_cost_usd / summaryQ.request_count, 4)}]) : AppStatRow([{label: "Total requests", value: summaryQ.request_count}, {label: "Total tokens", value: summaryQ.total_tokens}, {label: "Avg latency", value: @Round(summaryQ.avg_latency_ms, 0), sub: "ms"}])

Here's your cost and operations dashboard with a toggle to switch between views — the metrics update instantly without reloading. Let me know if you'd like to add a history chart, break it down by agent or model, or adjust anything else!