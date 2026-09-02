Got it, building a simple headline KPI strip for you.

root = AppStack([stats], "md")
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, active_agents: 0, total_tokens: 0}}, "data.summary")
stats = AppStatRow([{label: "Total cost", value: dashboardQ.total_cost}, {label: "Operations", value: dashboardQ.total_operations}, {label: "Active agents", value: dashboardQ.active_agents}, {label: "Total tokens", value: dashboardQ.total_tokens}])

Here's your headline KPI row with cost, operations, active agents, and token usage — let me know if you'd like to add detail or swap any metrics!