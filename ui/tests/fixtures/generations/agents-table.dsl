Sure — building that now.
root = AppStack([heading, costTable], "md")
heading = AppText("Agent costs", "title")
agentCostQ = Query("fetchTokenopsDashboard", [], [], "data.agents")
costTable = AppTable(agentCostQ, 20, "pages", false)
Here's a table showing all agents sorted by cost — you can search, sort by any column, and page through. Let me know if you'd like a chart view, filters, or different metrics added!