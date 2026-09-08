Sure — building that now.
root = AppStack([title, costBreakdown], "md")
title = AppText("Agent costs", "title")
agentCosts = Query("fetchTokenopsDashboard", [], {agents: []})
costBreakdown = AppTable(agentCosts.agents, 50, "pages", false)
Here's a table showing your agents sorted by cost — let me know if you'd like filters, charts, or additional columns!