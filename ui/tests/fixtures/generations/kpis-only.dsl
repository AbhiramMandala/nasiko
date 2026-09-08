Sure — building that now.
root = AppStack([kpis], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, total_cost_usd: 0, avg_latency_ms: null, period_days: 0})
kpis = AppStatRow([{label: "Total cost", value: "$" + @Round(summaryQ.total_cost_usd, 2), sub: "all time"}, {label: "Requests", value: summaryQ.request_count}, {label: "Total tokens", value: summaryQ.total_tokens}])
Here's your headline numbers — total cost, request count, and token usage all in one row. Let me know if you'd like to add charts, trends, or a breakdown by agent or model!