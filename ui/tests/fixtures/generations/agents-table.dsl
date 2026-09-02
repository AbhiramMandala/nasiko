Sure — building that now.
root = AppStack([heading, table], "md")
heading = AppCard(null, "Agent costs", null, null, "See which agents consume the most resources")
agentCosts = Query("fetchTokenopsDashboard", [], [], "data.agents")
table = AppTable(agentCosts, 20, "pages", false)
Here's a table showing all agents sorted by cost — you can search by name, sort any column, and page through. Let me know if you'd like to add filters, drill into specific agents, or break down costs by model!