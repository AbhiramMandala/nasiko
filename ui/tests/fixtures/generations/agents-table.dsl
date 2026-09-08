Sure — building that now.
root = AppStack([heading, costTable], "md")
heading = AppText("Agent costs", "title")
agentRows = Query("fetchTokenopsDashboard", [], [])
costTable = AppTable(agentRows.agents, 20, "pages", false)
Here's a table showing all agents sorted by their total costs — let me know if you'd like to add filters, charts, or more detail!