Sure — building that now.

root = AppStack([heading, billByService], "md")
heading = AppText("AWS bill by service", "title")
billData = Query("fetchUsageByModel", ["", 1, 50], [], "data")
billByService = AppTable(billData, 50, "pages", true)

Here's a table showing your AWS usage grouped by service — let me know if you'd like to add cost summaries, filters, or a visualization!