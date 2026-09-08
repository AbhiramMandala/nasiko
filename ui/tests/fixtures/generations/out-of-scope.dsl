I don't have a data source for AWS billing by service in scope. The available sources return TokenOps agent usage (costs, tokens, latency) and token consumption summaries, but nothing about AWS infrastructure billing or service breakdowns.

To build an AWS bill dashboard, I'd need a real data source that fetches that information — something like `fetchAwsBillByService()` or similar. Right now, I can only show you agent token costs, usage history, and per-model/per-agent breakdowns.

Would you like me to build a TokenOps cost dashboard instead, showing agent spending and usage metrics? Or if you have access to an AWS billing integration source, let me know its name and I can wire it up.