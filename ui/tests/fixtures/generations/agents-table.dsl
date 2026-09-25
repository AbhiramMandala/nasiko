Sure — building that now.

root = AppStack([heading, costChart, agentTable], "md")
heading = AppText("Agent spend", "title")
agentQ = Query("fetchTokenopsDashboard", [{}], {attributions: {rows: []}}, "data.attributions.rows")
agentRows = @Sort(agentQ, "total_cost", "desc")
costChart = AppChart({labels: agentRows.agent_name, datasets: [{label: "Cost (USD)", data: agentRows.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No agent data available")
agentTable = AppTable(agentRows, 25, "pages", false, null, null, "No agents to display")

Here's your agent spend dashboard with a bar chart showing costs and a sortable table below — let me know if you'd like to filter by time range or add more metrics!