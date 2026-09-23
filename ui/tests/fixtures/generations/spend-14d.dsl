Sure — building that now.

root = AppStack([heading, controls, chart, table], "md")
heading = AppText("Spend and request volume", "title")
$days = "14"
daysControl = AppSegmentedControl([{value: "7", label: "7 days"}, {value: "14", label: "14 days"}, {value: "30", label: "30 days"}], $days, "md", false, null, "Time range", null, changeDays)
changeDays = Action([@Set($days, $event), @Run(historyQ)])
controls = AppRow([daysControl], "md")
historyQ = Query("fetchUsageHistory", [$days], [{date: "", request_count: 0, total_cost_usd: 0}])
spendChart = AppChart({labels: historyQ.date, datasets: [{label: "Spend (USD)", data: historyQ.total_cost_usd}]}, "line", false, "currency", "USD", null, null, "auto", "No data for this period")
requestChart = AppChart({labels: historyQ.date, datasets: [{label: "Requests", data: historyQ.request_count}]}, "line", false, "compact", null, null, null, "auto", "No data for this period")
chart = AppGrid([spendChart, requestChart], null, "md")
table = AppTable(historyQ, 14, "pages", false, null, null, "No data for this period")

Here's your spend and request volume dashboard for the last 14 days, with a time-range picker, dual charts, and a detail table below — let me know if you'd like to adjust the view or add anything else!