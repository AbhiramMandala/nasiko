Sure — building that now.
root = AppStack([heading, controlRow, kpiRow, costChart, agentTable], "md")
heading = AppText("Cost dashboard", "title")
$range = "7d"
$agentSearch = ""
controlRow = AppRow([rangeControl, searchBox], "md")
rangeControl = AppSegmentedControl([{label: "24h"}, {label: "7d"}, {label: "30d"}], $range, "md", false, null, "Time window", null, setRange)
setRange = Action([@Set($range, $event)])
searchBox = AppSearch("md", null, false, false, "Search agents...", $agentSearch, null, null, null, null, null, runSearch)
runSearch = Action([@Set($agentSearch, $event)])
dashboardQ = Query("fetchTokenopsDashboard", [{range: $range}], {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}, avg_latency_ms: {current: null, previous: null, change_pct: null}}, attributions: {rows: []}, agents: [], token_usage: {prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 0, avg_latency_ms: null}}, "data")
kpiRow = AppStatRow([{label: "Total spend", value: dashboardQ.kpis.total_spend.current, delta: dashboardQ.kpis.total_spend.change_pct ? @Round(dashboardQ.kpis.total_spend.change_pct, 1) : null, trend: dashboardQ.kpis.total_spend.change_pct > 0 ? "up" : dashboardQ.kpis.total_spend.change_pct < 0 ? "down" : "neutral", format: "currency", currency: "USD"}, {label: "Total tokens", value: dashboardQ.kpis.total_tokens.current, delta: dashboardQ.kpis.total_tokens.change_pct ? @Round(dashboardQ.kpis.total_tokens.change_pct, 1) : null, trend: dashboardQ.kpis.total_tokens.change_pct > 0 ? "up" : dashboardQ.kpis.total_tokens.change_pct < 0 ? "down" : "neutral", format: "compact"}, {label: "Cost per operation", value: dashboardQ.kpis.cost_per_operation.current, delta: dashboardQ.kpis.cost_per_operation.change_pct ? @Round(dashboardQ.kpis.cost_per_operation.change_pct, 1) : null, trend: dashboardQ.kpis.cost_per_operation.change_pct > 0 ? "up" : dashboardQ.kpis.cost_per_operation.change_pct < 0 ? "down" : "neutral", format: "currency", currency: "USD"}], false)
costChart = AppChart({labels: dashboardQ.attributions.rows.agent_name, datasets: [{label: "Cost (USD)", data: dashboardQ.attributions.rows.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend in this period", false, "Cost by agent")
filteredAgents = @Filter(dashboardQ.agents, "agent_name", "contains", $agentSearch)
agentTable = AppTable(@Sort(filteredAgents, "total_cost", "desc"), 50, "pages", false, null, null, "No agents match your search", false)

Here's your cost dashboard with time-window controls, KPI metrics with trend deltas, a cost breakdown chart, and a searchable agent table — let me know if you'd like to adjust the layout, add more metrics, or filter by anything else!