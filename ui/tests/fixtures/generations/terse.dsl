Sure — building that now.
root = AppStack([headerRow, kpis, spendChart, agentTable], "md")
summaryQ = Query("fetchUsageSummary", [], {total_cost_usd: 0, request_count: 0})
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0, operations_last_24h: 0, average_cost: 0, active_agents: 0}, agents: []})
headerRow = AppRow([title], "md")
title = AppCodeSnippet("Spend Dashboard", null)
kpis = AppRow([costCard, opsCard, avgCard, agentsCard], "md")
costCard = AppStatCard("Total cost", dashboardQ.summary.total_cost, null, "neutral")
opsCard = AppStatCard("Total operations", dashboardQ.summary.total_operations, null, "neutral")
avgCard = AppStatCard("Avg cost per op", dashboardQ.summary.average_cost, null, "neutral")
agentsCard = AppStatCard("Active agents", dashboardQ.summary.active_agents, null, "neutral")
spendChart = AppChart({labels: dashboardQ.agents.agent_name, datasets: [{label: "Cost (USD)", data: dashboardQ.agents.total_cost}]}, "bar", false, "currency", "USD")
agentTable = AppTable(dashboardQ.agents, 20, "pages", false)
Here's your spend dashboard with key cost/ops metrics, a cost-by-agent bar chart, and a detailed agent table — let me know if you'd like to adjust the time range, add filters, or change what's displayed!