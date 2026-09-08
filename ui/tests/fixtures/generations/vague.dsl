Sure — building that now.

root = AppStack([heading, summary, agentBreakdown], "md")
heading = AppText("Cost overview", "title")
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, active_agents: 0}})
summary = AppStatRow([{label: "Total cost", value: dashboardQ.summary.total_cost, sub: "all time"}, {label: "Operations", value: dashboardQ.summary.total_operations}, {label: "Last 24h", value: dashboardQ.summary.operations_last_24h}])
agentRows = Query("fetchUsageByAgent", ["", 1, 50], [], "data")
agentBreakdown = AppTable(agentRows, 50, "pages", true)

Here's your cost overview with fleet-wide KPIs and a breakdown by agent — let me know if you'd like to see it sliced differently, add a time range, or focus on specific metrics!