Sure — building that now.
root = AppStack([title, costChart, agentTable], "md")
title = AppText("Agent cost analysis", "title")
dashboardQ = Query("fetchTokenopsDashboard", [{range: "30d"}], {attributions: {rows: []}}, "attributions.rows")
costChart = AppChart({labels: dashboardQ.agent_name, datasets: [{label: "Cost (USD)", data: dashboardQ.total_cost}]}, "bar", false, "currency", "USD")
agentTable = AppTable(@Sort(dashboardQ, "total_cost", "desc"), 50, "pages", false, null, null, "No agents found in this period")
Here's your agent cost dashboard with a bar chart showing relative spend and a sortable table for details — let me know if you'd like to adjust the time range or add more metrics!