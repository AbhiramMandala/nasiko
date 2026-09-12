Sure — building that now.
root = AppStack([heading, costBreakdown, agentTable], "md")
heading = AppText("Agent cost breakdown", "title")
agentQ = Query("fetchTokenopsDashboard", [{range: "30d"}], {agents: []}, "agents")
costBreakdown = AppChart({labels: agentQ.agent_name, datasets: [{label: "Cost (USD)", data: agentQ.total_cost}]}, "bar", false, "currency", "USD")
agentTable = AppTable(@Sort(agentQ, "total_cost", "desc"), 50, "pages", false, "", "No agents have incurred costs in this period")
Here's your agent cost breakdown with a bar chart showing the top spenders and a sortable table below — let me know if you'd like to adjust the time window or add more metrics!