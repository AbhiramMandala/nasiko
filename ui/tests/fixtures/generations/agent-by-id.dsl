Sure — building that now.

root = AppStack([heading, controls, details], "md")
heading = AppText("Agent usage lookup", "title")
$agentId = ""
idInput = AppInput("md", null, "Agent ID", null, null, false, false, false, false, "text", null, "agent-id-input", null, null, null, null, null, null, null, null, $agentId, null, null, null, null, null, lookupAgent)
lookupAgent = Action([@Set($agentId, $event), @Run(agentQ)])
agentQ = Query("fetchTokenopsDashboard", [{agentId: $agentId}], {kpis: {total_spend: {current: 0, previous: 0, change_pct: 0}, total_tokens: {current: 0, previous: 0, change_pct: 0}, cost_per_operation: {current: 0, previous: 0, change_pct: 0}, total_operations: {current: 0, previous: 0, change_pct: 0}, total_agents: {current: 0, previous: 0, change_pct: 0}, active_agents: {current: 0, previous: 0, change_pct: 0}, total_tool_calls: {current: 0, previous: 0, change_pct: 0}, avg_latency_ms: {current: 0, previous: 0, change_pct: 0}}, attributions: {rows: []}}, "data")
controls = AppField([idInput], "Agent ID")
spendTrend = agentQ.kpis.total_spend.change_pct > 0 ? "up" : agentQ.kpis.total_spend.change_pct < 0 ? "down" : "neutral"
spendCard = AppStatCard("Total spend", agentQ.kpis.total_spend.current, agentQ.kpis.total_spend.change_pct, spendTrend, false, "currency", "USD")
tokensTrend = agentQ.kpis.total_tokens.change_pct > 0 ? "up" : agentQ.kpis.total_tokens.change_pct < 0 ? "down" : "neutral"
tokensCard = AppStatCard("Tokens", agentQ.kpis.total_tokens.current, agentQ.kpis.total_tokens.change_pct, tokensTrend, false, "tokens")
costPerOpTrend = agentQ.kpis.cost_per_operation.change_pct > 0 ? "up" : agentQ.kpis.cost_per_operation.change_pct < 0 ? "down" : "neutral"
costPerOpCard = AppStatCard("Cost per operation", agentQ.kpis.cost_per_operation.current, agentQ.kpis.cost_per_operation.change_pct, costPerOpTrend, false, "currency", "USD")
opsTrend = agentQ.kpis.total_operations.change_pct > 0 ? "up" : agentQ.kpis.total_operations.change_pct < 0 ? "down" : "neutral"
opsCard = AppStatCard("Operations", agentQ.kpis.total_operations.current, agentQ.kpis.total_operations.change_pct, opsTrend, false, "compact")
kpiGrid = AppGrid([spendCard, tokensCard, costPerOpCard, opsCard], null, "md")
detailsTable = AppTable(agentQ.attributions.rows, 50, "pages", false, null, null, "No agent found with that ID")
details = AppStack([kpiGrid, detailsTable], "md")

Here's your agent lookup dashboard — type or paste an agent ID into the input, and it fetches that agent's spend, tokens, and operations with a comparison to the previous period, plus a detail table. Let me know if you'd like to adjust the metrics or add anything else!