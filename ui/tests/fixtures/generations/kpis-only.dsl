Sure — building that now.
root = AppStack([kpis], "md")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, total_cost_usd: 0, avg_latency_ms: 0, period_days: 0})
kpis = AppStatRow([{label: "Total cost", value: summaryQ.total_cost_usd, format: "currency", currency: "USD"}, {label: "Requests", value: summaryQ.request_count}, {label: "Total tokens", value: summaryQ.total_tokens, format: "compact"}, {label: "Avg latency", value: summaryQ.avg_latency_ms, format: "duration"}])
Here's your headline KPI strip — total cost, request count, token usage, and average latency. Let me know if you'd like to adjust which metrics show or add more detail.