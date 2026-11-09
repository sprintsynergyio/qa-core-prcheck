# Rule eval

`npm run eval` runs `evals/run.mjs` after the build. Each case is one saved diff, or one CLI or escape check, with the outcome written in that file. The command prints `pass` or `fail` for each name, then the counts:

```text
cases 11
passed 11
failed 0
```

Those counts are how many cases matched their expected outcome. They are not a precision, recall, or model score. The eval does not call an LLM and does not open a browser. `select` runs `playwright test --list` on the demo suite.

The diffs in `tests/fixtures/diffs/` were recorded in other repositories. They are applied to the demo checkout in this repository. A rename in a saved diff still sees the old file, because that file is still in the tree. The rename case says so.

Exit code 0 means every case matched. Exit code 1 means at least one did not. CI runs this on Linux, Windows, and macOS.
