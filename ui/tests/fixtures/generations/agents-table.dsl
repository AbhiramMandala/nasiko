Sure — building that now.
root = AppStack([title, costChart, agentTable], "md")
title = AppText("Agent cost breakdown", "title")
dashboardQ = Query("fetchTokenopsDashboard", [{}], {agents: []}, "agents")
costChart = AppChart({labels: dashboardQ.agent_name, datasets: [{label: "Cost (USD)", data: dashboardQ.total_cost}]}, "bar", false, "currency", "USD")
agentTable = AppTable(@Sort(dashboardQ, "total_cost", "desc"), 50, "pages", false, null, null, "No agents have incurred costs yet")
Here's your agent cost breakdown with a bar chart showing the top spenders and a sortable table below — let me know if you'd like to filter by date range or add any other details!