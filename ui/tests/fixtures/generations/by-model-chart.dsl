Sure — building that now.

root = AppStack([heading, modelChart, modelTable], "md")
heading = AppText("Usage by model", "title")
modelRows = Query("fetchFinopsAttributions", [{view: "agent"}], {rows: []}, "data")
modelChart = AppChart({labels: modelRows.rows.agent_name, datasets: [{label: "Cost (USD)", data: modelRows.rows.total_cost}]}, "bar", false, "currency", "USD", null, null, "auto", "No usage data available")
modelTable = AppTable(modelRows.rows, 50, "pages", false, null, null, "No usage data available")

Here's your usage by model with a bar chart showing cost distribution and a sortable table below — let me know if you'd like to adjust the metrics or add filters!