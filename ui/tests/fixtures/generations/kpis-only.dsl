Sure — building that now.
root = AppStack([heading, stats], "md")
heading = AppText("Usage summary", "title")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_tokens: 0, total_cost_usd: 0})
stats = AppStatRow([{label: "Total cost", value: summaryQ.total_cost_usd, sub: "all time"}, {label: "Requests", value: summaryQ.request_count}, {label: "Tokens", value: summaryQ.total_tokens}])
Here's your headline metrics dashboard — just the key numbers at a glance. Let me know if you'd like to add charts, tables, or drill into specific agents or models!