Sure — building that now.

root = AppStack([heading, summaryRow, agentTable], "md")
heading = AppText("Cost overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, total_tokens: 0})
summaryRow = AppStatRow([{label: "Total cost", value: summaryQ.total_cost_usd, sub: "all time"}, {label: "Requests", value: summaryQ.request_count}, {label: "Tokens", value: summaryQ.total_tokens}])
agentCostQ = Query("fetchUsageByAgent", [null, 1, 50], [], "data")
agentTable = AppTable(agentCostQ, 50, "pages", true)

Here's your cost dashboard with headline metrics and a breakdown by agent — let me know if you'd like to see trends, a different time window, or anything else adjusted!