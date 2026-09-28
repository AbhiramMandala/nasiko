Sure — building that now.

root = AppStack([heading, controls, agentDetails], "md")
heading = AppText("Agent usage lookup", "title")
$agentId = ""
agentIdBox = AppInput("md", null, "Agent ID", null, false, false, "text", "Paste an agent ID...", $agentId, null, setAgentId)
setAgentId = Action([@Set($agentId, $event), @Run(attributionsQ)])
controls = AppRow([agentIdBox], "md")
attributionsQ = Query("fetchFinopsAttributions", [{agentId: $agentId}], {rows: []}, "data")
agentRow = @First(attributionsQ.rows)
agentDetails = agentRow ? AppStack([costCard, opsCard, tokensCard, latencyCard], "md", null, null) : AppEmptyState("No agent found", "Try a different agent ID")
costCard = AppStatCard("Total cost", agentRow.total_cost, null, "neutral", false, "currency", "USD")
opsCard = AppStatCard("Operations", agentRow.operations, null, "neutral", false, "compact")
tokensCard = AppStatCard("Total tokens", agentRow.total_tokens, null, "neutral", false, "tokens")
latencyCard = AppStatCard("Avg latency", agentRow.avg_latency_ms, null, "neutral", false, "duration")

Here's a lookup form where you paste an agent ID and see its cost, operation count, token usage, and latency — let me know if you'd like to add more details or change the layout!