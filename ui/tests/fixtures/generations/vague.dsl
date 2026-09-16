Sure — building that now.

root = AppStack([heading, kpis, spendTrend, agentBreakdown], "md")
heading = AppText("Cost overview", "title")
dashboardQ = Query("fetchTokenopsDashboard", [{range: "7d"}], {kpis: {total_spend: {current: 0, previous: 0, change_pct: null}, total_operations: {current: 0, previous: 0, change_pct: null}, cost_per_operation: {current: 0, previous: 0, change_pct: null}}}, "data")
kpis = AppStatRow([{label: "Total spend", value: dashboardQ.kpis.total_spend.current, format: "currency", currency: "USD", sub: dashboardQ.kpis.total_spend.change_pct != null ? (@Abs(dashboardQ.kpis.total_spend.change_pct) > 0 ? (dashboardQ.kpis.total_spend.change_pct > 0 ? "+" : "") + @Round(dashboardQ.kpis.total_spend.change_pct, 1) + "%" : "0%") : "—"}, {label: "Operations", value: dashboardQ.kpis.total_operations.current, sub: dashboardQ.kpis.total_operations.change_pct != null ? (@Abs(dashboardQ.kpis.total_operations.change_pct) > 0 ? (dashboardQ.kpis.total_operations.change_pct > 0 ? "+" : "") + @Round(dashboardQ.kpis.total_operations.change_pct, 1) + "%" : "0%") : "—"}, {label: "Cost per op", value: dashboardQ.kpis.cost_per_operation.current, format: "currency", currency: "USD", sub: dashboardQ.kpis.cost_per_operation.change_pct != null ? (@Abs(dashboardQ.kpis.cost_per_operation.change_pct) > 0 ? (dashboardQ.kpis.cost_per_operation.change_pct > 0 ? "+" : "") + @Round(dashboardQ.kpis.cost_per_operation.change_pct, 1) + "%" : "0%") : "—"}])
timeseriesQ = Query("fetchSpendTimeseries", [{range: "7d"}], {points: []}, "data")
spendTrend = AppChart({labels: timeseriesQ.points.bucket_start, datasets: [{label: "Spend (USD)", data: timeseriesQ.points.spend_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No spend data in this period")
agentRows = dashboardQ.agents
agentChart = AppChart({labels: agentRows.agent_name, datasets: [{label: "Cost (USD)", data: agentRows.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No agents have incurred costs yet")
agentBreakdown = AppCard([agentChart], "Top agents by cost")

Here's your cost overview for the last 7 days with KPIs, a spend trend line, and a breakdown by agent — let me know if you'd like to adjust the time window or drill into specific details!