Sure — building that now.
root = AppStack([heading, kpis], "md")
heading = AppText("Usage summary", "title")
totalCostQ = Query("fetchUsageSummary", [], 0, "total_cost_usd")
totalTokensQ = Query("fetchUsageSummary", [], 0, "total_tokens")
requestCountQ = Query("fetchUsageSummary", [], 0, "request_count")
avgLatencyQ = Query("fetchUsageSummary", [], null, "avg_latency_ms")
kpis = AppStatRow([{label: "Total cost", value: totalCostQ, sub: "all time"}, {label: "Requests", value: requestCountQ}, {label: "Total tokens", value: totalTokensQ}, {label: "Avg latency", value: avgLatencyQ, sub: "ms"}])
Here's your headline metrics — four key numbers at a glance. Let me know if you'd like to adjust which metrics show up or add any filters.