Sure — building that now.
root = AppStack([heading, controls, chart], "md")
heading = AppText("Daily spend", "title")
$month = "2025-01"
monthInput = AppInput("md", null, "Month", null, false, false, "text", "YYYY-MM", $month, "Month (YYYY-MM)", monthInputAction)
monthInputAction = Action([@Set($month, $event), @Run(calendarQ)])
controls = AppRow([monthInput], "md")
calendarQ = Query("fetchSpendCalendar", [{month: $month}], {days: []}, "data")
chart = AppChart({labels: calendarQ.days.date, datasets: [{label: "Spend (USD)", data: calendarQ.days.spend_usd}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend recorded for this month")

Here's your daily spend calendar with a month input — type any month in YYYY-MM format and the chart updates to show that month's daily breakdown.