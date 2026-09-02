Got it — building your AWS bill breakdown now.

root = AppStack([header, billByService], "md")
header = AppRow([title], "md")
title = AppStatCard("AWS Services", null, null, "neutral")
billByService = AppTable(serviceRows, 20, "pages", false)
serviceRows = Query("fetchUsageByModel", ["", 1, 20], [], "data")

Here's a table showing usage grouped by service with cost and token details — let me know if you'd like me to pivot it differently, add filters, or break it down another way!