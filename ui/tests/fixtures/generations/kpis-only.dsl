Sure — building that now.
root = AppStack([heading, stats], "md")
heading = AppText("Usage summary", "title")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_cost_usd: 0})
stats = AppStatRow([{label: "Requests", value: summaryQ.request_count}, {label: "Total cost", value: summaryQ.total_cost_usd, sub: "USD"}])
Here's your headline numbers — just the key metrics at a glance. Let me know if you'd like to add anything else!