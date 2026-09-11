Sure — building that now.
root = AppStack([heading, chart, table], "md")
heading = AppText("Spend and request volume", "title")
historyQ = Query("fetchUsageHistory", [14], [])
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}, {label: "Requests", data: historyQ.request_count}]}, "line", false, "currency", "USD")
table = AppTable(historyQ, 14, "pages", false, null, null, "No spend in the last 14 days")
Here's a 14-day spend and request volume dashboard with a line chart and detailed daily table — let me know if you'd like to adjust the layout or add more metrics!