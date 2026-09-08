Sure — building that now.

root = AppStack([heading, summarySection, agentSection, modelSection], "md")
heading = AppText("Token Ops Spend Dashboard", "title")
summarySection = AppStack([summaryHeading, summaryStats], "md")
summaryHeading = AppText("Overall usage summary", "subtitle")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, total_cost_usd: 0, avg_latency_ms: null, period_days: 0})
summaryStats = AppStatRow([{label: "Total cost", value: "$" + @Round(summaryQ.total_cost_usd, 2)}, {label: "Requests", value: summaryQ.request_count}, {label: "Total tokens", value: summaryQ.total_tokens}])
agentSection = AppStack([agentHeading, agentTable], "md")
agentHeading = AppText("Spend by agent", "subtitle")
agentRows = Query("fetchUsageByAgent", [null, 1, 50], [], "data")
agentTable = AppTable(agentRows, 50, "pages", false)
modelSection = AppStack([modelHeading, modelTable], "md")
modelHeading = AppText("Spend by model", "subtitle")
modelRows = Query("fetchUsageByModel", [null, 1, 50], [], "data")
modelTable = AppTable(modelRows, 50, "pages", false)

Here's your spend dashboard with overall usage KPIs and tables showing cost broken down by agent and by model — let me know if you'd like to add filters, charts, or different metrics!