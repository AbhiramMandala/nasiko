Sure — building that now.
root = AppStack([heading, agentTable], "md")
heading = AppText("Agent costs", "title")
agentRows = Query("fetchTokenopsDashboard", [], [], "data.agents")
agentTable = AppTable(agentRows, 20, "pages", false)
Here's a table showing all your agents sorted by cost, with token and operational metrics — let me know if you'd like to filter, chart, or add more detail!