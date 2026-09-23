Sure — building that now.
root = AppStack([heading, controls, chart], "md")
heading = AppText("Daily spend", "title")
$month = "2026-07"
monthPicker = AppSegmentedControl([{value: "2026-07", label: "July"}, {value: "2026-08", label: "August"}, {value: "2026-09", label: "September"}], $month, "md", false, null, "Month", null, pickMonth)
pickMonth = Action([@Set($month, $event), @Run(calendarQ)])
controls = AppRow([monthPicker], "md")
calendarQ = Query("fetchSpendCalendar", [{month: $month}], {days: []}, "data")
chart = AppChart({labels: calendarQ.days.date, datasets: [{label: "Spend (USD)", data: calendarQ.days.spend_usd}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend in this month")

Here's your daily spend chart for July, August, or September 2026 — pick the month with the segmented control and it'll refresh automatically!