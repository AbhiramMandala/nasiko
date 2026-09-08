Sure — building that now.
root = AppStack([heading, toggleRow, kpis, agentTable], "md")
heading = AppText("TokenOps Dashboard", "title")
$view = "cost"
toggleRow = AppRow([costBtn, opsBtn], "sm")
costBtn = AppButton("Cost", "primary", null, null, null, null, null, null, null, null, showCost)
opsBtn = AppButton("Operations", "secondary", null, null, null, null, null, null, null, null, showOps)
showCost = Action([@Set($view, "cost")])
showOps = Action([@Set($view, "ops")])
dashboardQ = Query("fetchTokenopsDashboard", [], {summary: {total_cost: 0, total_operations: 0}}, "data.summary")
costLabel = $view == "cost" ? "Total cost" : "Operations"
costValue = $view == "cost" ? dashboardQ.total_cost : dashboardQ.total_operations
kpis = AppStatCard(costLabel, costValue)
agentRowsQ = Query("fetchTokenopsDashboard", [], {agents: []}, "data.agents")
agentTable = AppTable(agentRowsQ, 20, "pages", false)
Here's your cost/ops dashboard with a toggle between the two views and a table of per-agent metrics — let me know if you'd like to add charts, filters, or other details!