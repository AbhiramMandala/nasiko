Sure — building that now.

root = AppStack([heading, controls, chart], "md")
heading = AppText("Daily spend", "title")
$month = "2026-07"
monthPicker = AppSegmentedControl([{value: "2026-07", label: "July"}, {value: "2026-08", label: "August"}, {value: "2026-09", label: "September"}], $month, "md", false, null, "Month", null, pickMonth)
pickMonth = Action([@Set($month, $event), @Run(spendQ)])
spendQ = Query("fetchSpendCalendar", [{month: $month}], {days: []}, "data")
chart = AppChart({labels: spendQ.days.date, datasets: [{label: "Spend (USD)", data: spendQ.days.spend_usd}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend data for this month")
controls = AppRow([monthPicker], "md")

Here's your daily spend calendar with a month picker — choose July, August, or September 2026 to see the bar chart update.