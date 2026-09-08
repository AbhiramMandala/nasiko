Sure — building a cost breakdown table for you now.

root = AppStack([heading, agentCostTable], "md")
heading = AppText("Agent costs", "title")
agentCostQ = Query("fetchTokenopsDashboard", [], {agents: []}, "data.agents")
agentCostTable = AppTable(agentCostQ, 20, "pages", false)

Here's a table showing which agents cost the most, sorted by total cost — let me know if you'd like to add filters, a chart view, or drill into specific agents!