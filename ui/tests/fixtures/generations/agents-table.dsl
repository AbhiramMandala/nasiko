Sure — building that now.

root = AppStack([heading, breakdown, table], "md")
heading = AppText("Agent spend", "title")
agentQ = Query("fetchFinopsAttributions", [{range: "7d", view: "agent", sortBy: "cost", sortDir: "desc", limit: 50}], {view: "agent", rows: []}, "data")
breakdown = AppChart({labels: agentQ.rows.agent_name, datasets: [{label: "Cost (USD)", data: agentQ.rows.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No agent spend in the last 7 days")
table = AppTable(agentQ.rows, 50, "pages", false, null, null, "No agent spend in the last 7 days")

Here's your agent spend dashboard with a bar chart showing the top spenders and a sortable table below — let me know if you'd like to filter by date range, add more columns, or adjust the view!