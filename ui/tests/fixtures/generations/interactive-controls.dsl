Sure — building that now.
root = AppStack([heading, controls, kpiStrip, agentChart, agentTable], "md")
heading = AppText("TokenOps cost dashboard", "title")
$searchQuery = ""
$timeWindow = "7d"
searchAction = Action([@Set($searchQuery, $event)])
timeAction = Action([@Set($timeWindow, $event), @Run(dashboardQ)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $searchQuery, null, null, null, null, null, searchAction)
timeButtons = AppSegmentedControl([{value: "24h", label: "24h"}, {value: "7d", label: "7d"}, {value: "30d", label: "30d"}], $timeWindow, "md", false, null, "Time window", null, timeAction)
controls = AppRow([searchBox, timeButtons], "md", "center")
dashboardQ = Query("fetchTokenopsDashboard", [{range: $timeWindow}], {kpis: {total_spend: {current: 0, previous: 0}, total_operations: {current: 0, previous: 0}, total_tokens: {current: 0, previous: 0}, avg_latency_ms: {current: 0, previous: 0}}, attributions: {rows: []}, spend_by_agent: {slices: [], total_spend_usd: 0}}, "data")
kpiStrip = AppStatRow([{label: "Total spend", value: dashboardQ.kpis.total_spend.current, format: "currency", sub: dashboardQ.kpis.total_spend.change_pct != null ? (@Round(dashboardQ.kpis.total_spend.change_pct, 1) + "%") : "—"}, {label: "Operations", value: dashboardQ.kpis.total_operations.current, sub: dashboardQ.kpis.total_operations.change_pct != null ? (@Round(dashboardQ.kpis.total_operations.change_pct, 1) + "%") : "—"}, {label: "Total tokens", value: dashboardQ.kpis.total_tokens.current, format: "compact", sub: dashboardQ.kpis.total_tokens.change_pct != null ? (@Round(dashboardQ.kpis.total_tokens.change_pct, 1) + "%") : "—"}, {label: "Avg latency", value: dashboardQ.kpis.avg_latency_ms.current, format: "duration", sub: dashboardQ.kpis.avg_latency_ms.change_pct != null ? (@Round(dashboardQ.kpis.avg_latency_ms.change_pct, 1) + "%") : "—"}])
filteredAgents = @Filter(dashboardQ.attributions.rows, "agent_name", "contains", $searchQuery)
agentChart = AppChart({labels: filteredAgents.agent_name, datasets: [{label: "Cost (USD)", data: filteredAgents.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No agents match that filter")
agentTable = AppTable(filteredAgents, 20, "pages", false, null, null, "No agents match that filter")

Here's your cost dashboard with time-window controls and a searchable agent breakdown — let me know if you'd like to adjust the layout, add more metrics, or change the chart type!