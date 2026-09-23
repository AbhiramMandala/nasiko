Sure — building that now.
root = AppStack([heading, controls, chart], "md")
heading = AppText("Daily spend", "title")
$month = ""
monthInput = AppInput("md", null, "Month", null, null, false, false, false, false, "text", null, null, "YYYY-MM", null, null, null, null, null, null, null, null, monthInput_action)
monthInput_action = Action([@Set($month, $event)])
calendarQ = Query("fetchSpendCalendar", [{month: $month}], {days: []}, "data")
controls = AppRow([monthInput], "md")
chart = AppChart({labels: calendarQ.days.date, datasets: [{label: "Spend (USD)", data: calendarQ.days.spend_usd}]}, "bar", false, "currency", "USD", null, null, "auto", "No spend data for that month")

Here's a daily spend dashboard with a month input and a bar chart — type a month in YYYY-MM format and the chart will load that calendar's spend by day.