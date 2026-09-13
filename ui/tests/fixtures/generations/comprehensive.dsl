Sure — building that now.
root = AppStack([header, kpiRow, chartsSection, agentTable], "md")
header = AppText("TokenOps Dashboard", "title")
dashboardQ = Query("fetchTokenopsDashboard", [{range: "7d"}], {data: {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}}, summary: {total_cost: 0, total_operations: 0, active_agents: 0}, attributions: {rows: []}, agents: [], token_usage: {total_tokens: 0}}}, "data")
kpiRow = AppStatRow([{label: "Total spend", value: dashboardQ.kpis.total_spend.current, sub: "last 7 days", delta: dashboardQ.kpis.total_spend.change_pct, format: "currency"}, {label: "Total tokens", value: dashboardQ.kpis.total_tokens.current, delta: dashboardQ.kpis.total_tokens.change_pct}, {label: "Avg cost/op", value: dashboardQ.kpis.cost_per_operation.current, delta: dashboardQ.kpis.cost_per_operation.change_pct, format: "currency"}])
chartsSection = AppGrid([spendChart, tokenChart], "1fr 1fr", "md")
spendChart = AppChart({labels: dashboardQ.attributions.rows.agent_name, datasets: [{label: "Spend (USD)", data: dashboardQ.attributions.rows.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend data available")
tokenChart = AppChart({labels: dashboardQ.attributions.rows.agent_name, datasets: [{label: "Total tokens", data: dashboardQ.attributions.rows.total_tokens}]}, "bar", false, "compact", null, null, null, "auto", "No token data available")
agentTableTitle = AppText("Agent usage breakdown", "subtitle")
agentTable = AppTable(dashboardQ.attributions.rows, 50, "pages", false, null, null, "No agents have generated usage yet")

Here's your comprehensive TokenOps dashboard with KPI metrics, side-by-side spend and token charts, and a detailed agent usage table — let me know if you'd like to adjust the time range, add more visualizations, or focus on specific metrics!