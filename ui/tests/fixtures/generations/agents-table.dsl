Sure — building that now.
root = AppStack([heading, table], "md")
heading = AppText("Agent cost breakdown", "title")
agentCostRows = Query("fetchTokenopsDashboard", [{range: "30d", view: "agent"}], [], "data.agents")
table = AppTable(agentCostRows, 20, "pages", false)
Here's a cost breakdown table showing your top-spending agents with sortable columns — let me know if you'd like to adjust the time range or add any filters!