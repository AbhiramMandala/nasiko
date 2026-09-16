Sure — building that now.
root = AppStack([kpis], "md")
dashboardQ = Query("fetchTokenopsDashboard", [{}], {kpis: {total_spend: {current: 0}, total_operations: {current: 0}, total_tokens: {current: 0}, avg_latency_ms: {current: 0}}}, "data")
kpis = AppStatRow([{label: "Total spend", value: dashboardQ.kpis.total_spend.current, format: "currency", currency: "USD"}, {label: "Operations", value: dashboardQ.kpis.total_operations.current}, {label: "Tokens", value: dashboardQ.kpis.total_tokens.current}, {label: "Avg latency", value: dashboardQ.kpis.avg_latency_ms.current, format: "duration"}])
Here's your headline KPI strip with spend, operations, tokens, and latency — let me know if you'd like to adjust the metrics or add anything else!