Sure — building that now.

root = AppStack([heading, controls, chart], "md")
heading = AppText("Usage history", "title")
$days = "7"
rangePicker = AppSegmentedControl([{value: "7", label: "7 days"}, {value: "30", label: "30 days"}], $days, "md", false, null, "Time range", null, setRange)
setRange = Action([@Set($days, $event), @Run(historyQ)])
historyQ = Query("fetchUsageHistory", [$days], [])
controls = AppRow([rangePicker], "md")
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No usage data in this period")

Here's your usage history with a 7/30-day toggle — the chart updates when you switch between them!