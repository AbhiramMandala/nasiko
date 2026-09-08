Sure — building that spend dashboard now.

root = AppStack([heading, summaryKpis, agentSection, modelSection], "md")
heading = AppText("Token Ops spend", "title")
summaryQ = Query("fetchUsageSummary", [], {request_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_tokens: 0, total_cost_usd: 0, avg_latency_ms: null, period_days: 0})
summaryKpis = AppStatRow([{label: "Total cost", value: "$" + @Round(summaryQ.total_cost_usd, 2), sub: summaryQ.period_days + " days"}, {label: "Total tokens", value: @Sum([summaryQ.total_input_tokens, summaryQ.total_output_tokens])}])
agentSection = AppStack([agentHeading, agentTable], "md")
agentHeading = AppText("Cost by agent", "subtitle")
agentRows = Query("fetchUsageByAgent", [null, 1, 50], [], "data")
agentTable = AppTable(agentRows, 50, "pages", false)
modelSection = AppStack([modelHeading, modelTable], "md")
modelHeading = AppText("Cost by model", "subtitle")
modelRows = Query("fetchUsageByModel", [null, 1, 50], [], "data")
modelTable = AppTable(modelRows, 50, "pages", false)

Here's your spend dashboard with overall cost KPIs and tables showing usage breakdown by agent and model — let me know if you'd like to add a chart, time filtering, or other details!