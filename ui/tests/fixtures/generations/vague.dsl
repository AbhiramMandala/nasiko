Sure — building that now.

root = AppStack([heading, summary, agentBreakdown], "md")
heading = AppText("Cost overview", "title")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0, avg_latency_ms: null})
summary = AppStatRow([{label: "Total cost", value: "$" + @Round(summaryQ.total_cost_usd, 2), sub: "all time"}, {label: "Requests", value: @Count(summaryQ.request_count ? [summaryQ.request_count] : [])}])
agentDataQ = Query("fetchTokenopsDashboard", [], {agents: []}, "data.agents")
agentBreakdown = AppTable(agentDataQ, 20, "pages", false)

Here's your cost overview with the total spend, request count, and a breakdown by agent — let me know if you'd like to see trends over time, filter by a specific period, or drill into any agent's details!