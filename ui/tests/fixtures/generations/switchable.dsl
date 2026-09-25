Sure — building that now.

root = AppStack([heading, viewPicker, kpiRow, breakdown], "md")
heading = AppText("TokenOps overview", "title")
$view = "cost"
viewPicker = AppSegmentedControl([{value: "cost", label: "Cost"}, {value: "ops", label: "Operations"}], $view, "md", false, null, "View", null, switchView)
switchView = Action([@Set($view, $event)])
dashboardQ = Query("fetchTokenopsDashboard", [{}], {kpis: {total_spend: {current: 0, previous: 0}, total_operations: {current: 0, previous: 0}}, attributions: {rows: []}}, "data")
kpiRow = $view == "cost" ? AppStatCard("Total spend", dashboardQ.kpis.total_spend.current, dashboardQ.kpis.total_spend.current - dashboardQ.kpis.total_spend.previous, dashboardQ.kpis.total_spend.current > dashboardQ.kpis.total_spend.previous ? "up" : dashboardQ.kpis.total_spend.current < dashboardQ.kpis.total_spend.previous ? "down" : "neutral", false, "currency", "USD") : AppStatCard("Total operations", dashboardQ.kpis.total_operations.current, dashboardQ.kpis.total_operations.current - dashboardQ.kpis.total_operations.previous, dashboardQ.kpis.total_operations.current > dashboardQ.kpis.total_operations.previous ? "up" : dashboardQ.kpis.total_operations.current < dashboardQ.kpis.total_operations.previous ? "down" : "neutral")
breakdown = $view == "cost" ? AppChart({labels: dashboardQ.attributions.rows.agent_name, datasets: [{label: "Cost (USD)", data: dashboardQ.attributions.rows.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend in this period") : AppChart({labels: dashboardQ.attributions.rows.agent_name, datasets: [{label: "Operations", data: dashboardQ.attributions.rows.operations}]}, "bar", false, "number", null, null, null, "auto", "No operations in this period")

Here's your cost dashboard with a view toggle — switch between total spend and operations, each with their own KPI and breakdown chart. Let me know if you'd like to add filters, adjust the time range, or change the layout!