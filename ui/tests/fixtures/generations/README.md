# Recorded generations

Real model output, captured from a live Weave, replayed by
`ui/scripts/eval-generations.mjs --offline` in CI.

They exist because the unit tests structurally cannot cover this: they prove
the parser, materializer and renderer are correct in isolation, and say nothing
about whether the generator writes DSL those modules can actually handle. Every
change to the catalog, the runtime or the prompt is checked against what the
model really produces — without spending a token or needing a model to be up.

## Re-recording

```
set -a && source .env && set +a     # WEAVE_INTERNAL_TOKEN
just eval-ui-record
```

Do it deliberately, and read the diff. It is the review artifact: it shows
exactly what the model started writing differently after a prompt or catalog
change, which is otherwise invisible until someone notices a dashboard looks
wrong.

A case with no recording fails the run — a case that never executes is worse
than no case, because the count says it passed. The one exception is an empty
directory: no baseline yet means nothing to regress against, so it passes with
a note rather than parking CI on red.
