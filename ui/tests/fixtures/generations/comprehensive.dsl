Building that now.

root = AppStack([banner, kpiSection, chartsSection, dataSection], "md")
banner = AppBanner([], "horizontal", "TokenOps Dashboard", "Real-time visibility into token usage, costs, and performance")
kpiSection = AppStack([kpiHeading, kpiRow], "md")
kpiHeading = AppText("Key metrics", "title")
dashboardQ = Query("fetchTokenopsDashboard", [{range: "7d"}], {data: {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_tokens: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}, avg_latency_ms: {current: null, previous: null, change_pct: null}}}}, "data.kpis")
kpiRow = AppStatRow([{label: "Total spend", value: dashboardQ.total_spend.current, sub: "last 7 days", format: "currency", currency: "USD", delta: dashboardQ.total_spend.change_pct ? @Round(dashboardQ.total_spend.change_pct, 1) + "%" : null, trend: dashboardQ.total_spend.change_pct > 0 ? "up" : dashboardQ.total_spend.change_pct < 0 ? "down" : "neutral"}, {label: "Total tokens", value: dashboardQ.total_tokens.current, sub: "all usage", format: "tokens", delta: dashboardQ.total_tokens.change_pct ? @Round(dashboardQ.total_tokens.change_pct, 1) + "%" : null, trend: dashboardQ.total_tokens.change_pct > 0 ? "up" : dashboardQ.total_tokens.change_pct < 0 ? "down" : "neutral"}, {label: "Cost per operation", value: dashboardQ.cost_per_operation.current, format: "currency", currency: "USD", delta: dashboardQ.cost_per_operation.change_pct ? @Round(dashboardQ.cost_per_operation.change_pct, 1) + "%" : null, trend: dashboardQ.cost_per_operation.change_pct > 0 ? "up" : dashboardQ.cost_per_operation.change_pct < 0 ? "down" : "neutral"}, {label: "Avg latency", value: dashboardQ.avg_latency_ms.current, format: "duration", delta: dashboardQ.avg_latency_ms.change_pct ? @Round(dashboardQ.avg_latency_ms.change_pct, 1) + "%" : null, trend: dashboardQ.avg_latency_ms.change_pct > 0 ? "up" : dashboardQ.avg_latency_ms.change_pct < 0 ? "down" : "neutral"}])
chartsSection = AppStack([chartsHeading, chartsGrid], "md")
chartsHeading = AppText("Usage trends", "title")
timeseriesQ = Query("fetchSpendTimeseries", [{range: "7d"}], {data: {points: []}}, "data.points")
chartsGrid = AppGrid([spendChart, tokensChart], "1fr 1fr")
spendChart = AppChart({labels: timeseriesQ.bucket_start, datasets: [{label: "Spend (USD)", data: timeseriesQ.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data in this period")
tokensChart = AppChart({labels: timeseriesQ.bucket_start, datasets: [{label: "Operations", data: timeseriesQ.operations}]}, "line", false, "compact", null, null, null, "auto", "No operation data in this period")
dataSection = AppStack([dataHeading, dataGrid], "md")
dataHeading = AppText("Breakdown by agent", "title")
$agentPage = 1
agentRowsQ = Query("fetchUsageByAgent", ["", $agentPage, 20], [], "data")
agentTable = AppTable(agentRowsQ, 20, "pages", false, null, null, "No agents have recorded usage yet")
dataGrid = AppGrid([agentTable], 1)

Here's your comprehensive TokenOps dashboard with KPI metrics, spend and operation trends, and a detailed agent breakdown — let me know if you'd like to adjust the layout, add filters, or dive deeper into any metric!