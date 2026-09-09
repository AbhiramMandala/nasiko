Sure — building that now.
root = AppStack([heading, agentTable], "md")
heading = AppText("Cost by agent", "title")
agentData = Query("fetchTokenopsDashboard", [{range: "30d", view: "agent"}], [], "data.agents")
agentTable = AppTable(agentData, 50, "pages", false)
Here's a table showing your agents ranked by cost over the last 30 days — let me know if you'd like a different time window or additional breakdowns!