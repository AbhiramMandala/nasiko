Sure — building that now.
root = AppStack([heading, table], "md")
heading = AppCard(null, "Agent costs", null, null, "Top agents by total cost", null, null, null, null, null, null, null, null, false)
agentRows = Query("fetchTokenopsDashboard", [], [], "data.agents")
table = AppTable(agentRows, 20, "pages", false)
Here's a table of agents ranked by cost with all their usage metrics — let me know if you'd like to filter, sort by a specific field, or add a chart breakdown!