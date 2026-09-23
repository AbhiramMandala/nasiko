Sure — building that now.
root = AppStack([heading, controls, chart], "md")
heading = AppText("Usage history", "title")
$days = "7"
dayPicker = AppSegmentedControl([{value: "7", label: "7 days"}, {value: "30", label: "30 days"}], $days, "md", false, null, "Time range", null, switchDays)
switchDays = Action([@Set($days, $event), @Run(historyQ)])
controls = AppRow([dayPicker], "md")
historyQ = Query("fetchUsageHistory", [$days], [])
chart = AppChart({labels: historyQ.date, datasets: [{label: "Cost (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No usage data for this period")
Here's your usage history chart with a 7/30 day toggle — let me know if you'd like to add more metrics or adjust the view!