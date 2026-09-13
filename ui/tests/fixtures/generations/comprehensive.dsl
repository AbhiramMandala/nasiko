Sure — building that now.

root = AppStack([header, kpiRow, chartsSection, agentTable], "md")
header = AppText("TokenOps Dashboard", "title")
dashboardQ = Query("fetchTokenopsDashboard", [{range: "7d"}], {data: {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}, avg_latency_ms: {current: null, previous: null, change_pct: null}}, summary: {total_cost: 0, total_operations: 0, active_agents: 0}, attributions: {rows: []}, agents: [], token_usage: {total_tokens: 0, avg_latency_ms: null}}})
kpiRow = AppStatRow([{label: "Total spend", value: @Round(dashboardQ.data.kpis.total_spend.current, 2), delta: dashboardQ.data.kpis.total_spend.change_pct, trend: dashboardQ.data.kpis.total_spend.change_pct > 0 ? "up" : dashboardQ.data.kpis.total_spend.change_pct < 0 ? "down" : "neutral", format: "currency", currency: "USD"}, {label: "Total tokens", value: @Round(dashboardQ.data.kpis.total_tokens.current, 0), delta: dashboardQ.data.kpis.total_tokens.change_pct, trend: dashboardQ.data.kpis.total_tokens.change_pct > 0 ? "up" : dashboardQ.data.kpis.total_tokens.change_pct < 0 ? "down" : "neutral"}, {label: "Cost per op", value: @Round(dashboardQ.data.kpis.cost_per_operation.current, 4), delta: dashboardQ.data.kpis.cost_per_operation.change_pct, trend: dashboardQ.data.kpis.cost_per_operation.change_pct > 0 ? "up" : dashboardQ.data.kpis.cost_per_operation.change_pct < 0 ? "down" : "neutral", format: "currency", currency: "USD"}])
chartsSection = AppStack([spendChartLabel, spendChart, tokenChartLabel, tokenChart], "md")
spendChartLabel = AppText("Spend over time", "subtitle")
spendTimeseries = Query("fetchSpendTimeseries", [{range: "7d"}], {data: {points: []}}, "data.points")
spendChart = AppChart({labels: spendTimeseries.bucket_start, datasets: [{label: "Spend (USD)", data: spendTimeseries.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data available")
tokenChartLabel = AppText("Operations over time", "subtitle")
opChart = AppChart({labels: spendTimeseries.bucket_start, datasets: [{label: "Operations", data: spendTimeseries.operations}]}, "line", false, "number", null, null, null, "auto", "No operations data available")
tokenChart = opChart
agentTableLabel = AppText("Agent usage", "subtitle")
agentTableContainer = AppStack([agentTableLabel, agentTable], "md")
agentRows = Query("fetchTokenopsDashboard", [{range: "7d"}], {data: {agents: []}}, "data.agents")
agentTable = AppTable(agentRows, 20, "pages", false, null, null, "No agents have run in this period")

Here's your comprehensive TokenOps dashboard with KPI strip, spend and operations timeseries charts, and a sortable agent usage table — let me know if you'd like to adjust the layout, add more metrics, or drill into specific agents!