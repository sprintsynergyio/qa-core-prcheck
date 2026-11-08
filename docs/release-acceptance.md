# Release acceptance

This note is the gap matrix and the checklist for the tree after 0.1.0. It is not a claim that the package is published or that a pull request is safe to merge without review.

Published baseline: `@sprintsynergy/qa-core-prcheck` 0.1.0. The `package.json` version stays `0.1.0` until the owner bumps it, tags, and publishes. This tree does not tag or publish.

Product intent, taken from the README, the changelog, the tests, and the workflows:

- A rule-first picker. Changed files map to Playwright spec files, with a written reason. A file that no rule maps runs the full suite.
- The result is advisory. A failed test is reported. It does not fail the GitHub Action job unless `fail-on-test-failure` is `true`. It is not a guarantee that the pull request is safe to merge.
- Optional LLM ranking is off by default. It may reorder and annotate. It cannot add, remove, or run a spec, and it cannot change the verdict or the exit code.
- Fork pull requests and Dependabot do not get a write token, and this repo's workflow does not pass an LLM secret.

## Gap matrix

| Capability | Before (0.1.0) | After this tree | Evidence |
| --- | --- | --- | --- |
| Diff, classify, select, suggest | Implemented | Unchanged rules | Existing unit tests |
| Run picked specs with `--forbid-only` | Implemented | Unchanged | Existing unit tests |
| Markdown summary, sticky comment, fork skip, read-only token skip | Implemented | Unchanged | Existing unit tests |
| LLM ranking in `check`, off by default, answer checked strictly | Implemented | Still the local `check` path. `--skip-llm` skips it | `tests/check-cli.test.mjs`, `tests/llm-rank.test.mjs` |
| Config size, count, and character limits | Named as later work | Implemented. The config cannot raise them | `tests/impact-config.test.mjs` |
| Kill timeout other than a fixed 30 minutes | Fixed 30 minutes | `--timeout-minutes` and the action input, 1 to 30 only | `tests/run-cli.test.mjs`, `tests/check-cli.test.mjs`, `tests/workflow-files.test.mjs` |
| Ranking after Playwright, key not in that process | Not in the action | `rank` command. The check step unsets the key. `llm` defaults to `false` | `tests/rank-cli.test.mjs`, `tests/workflow-files.test.mjs` |
| Action reads `llm.status` and warns on skip | Not done when `check --json` ran | Rank step prints the warning from the JSON | `tests/workflow-files.test.mjs` |
| Key shape and request redaction | Answer and errors scrubbed | Key must be one printable line of at most 4096 characters. The request body is scrubbed before send. `%` and line breaks are not masked into the log | `tests/llm-rank.test.mjs`, `tests/workflow-files.test.mjs` |
| Call cap | Two attempts, input and output caps | Same caps. No config key can raise them | `tests/llm-rank.test.mjs` |
| This repo's workflow passes an LLM secret | It did not | It still does not. `uses: ./` would let a pull request read a secret | `tests/workflow-files.test.mjs` |
| Org links | `sprintsynergyhq` in `package.json` | `sprintsynergyio` | `package.json` |
| CI action majors | `ci.yml` on v4, `prcheck.yml` on v7 | Both on v7 | `tests/workflow-files.test.mjs` |
| Eval suite beyond unit fixtures (roadmap PR 10) | Not a separate product | Deferred. The fixtures under `tests/fixtures/` remain the regression suite | This file |
| Live GitHub rendering checks | Open in the README | Still open. Not run from this environment | README, Live Checks |

## Release checklist

- [x] Rules still decide selection, verdict, and exit code. LLM output cannot add a spec.
- [x] LLM stays off unless a workflow sets `llm: true` and supplies `PRCHECK_LLM_API_KEY`. This repo's workflow does neither.
- [x] Fork workflow path stays `pull_request` only, `pull-requests: write` only for the comment, checkout with `persist-credentials: false`, and `comment: false` for forks and Dependabot.
- [x] Config from the pull request cannot choose the key's env var, raise the timeout past 30 minutes, or raise the LLM attempt cap.
- [x] `npm test` (build, typecheck is separate), `npm run typecheck`, and a packed CLI smoke test were run for this change. Record the results in the pull request.
- [ ] Owner reviews the diff, including `action.yml` and the decision not to pass a secret from `prcheck.yml`.
- [ ] Owner bumps the version, updates the changelog date, tags, and publishes only after that review. This tree does not do those steps.
- [ ] Owner runs the live checks still listed in the README on a throwaway pull request before calling the comment rendering done.
- [ ] Owner pins a trusted tag before setting `llm: true` on a repository that holds a real API key.

## Deferred on purpose

- PR 10 eval fixtures and a separate docs site. The current tests are the regression suite. A new eval harness would be a new product surface.
- Making a failed test fail the job by default. The README defines v1 as advisory.
- Per-test selection, tsconfig path aliases, and runtime data-file tracking. The README lists these as select limits.
- HTML report. `run` replaces reporters with JSON.
- A configurable timeout above 30 minutes, or a timeout key in the pull request config.
- Passing `secrets.PRCHECK_LLM_API_KEY` from this repo's `pull_request` workflow while it uses `uses: ./`.

## Remaining risks

- A same-repository pull request can change `action.yml` and the CLI, because the workflow uses `uses: ./`. The GITHUB_TOKEN on `pull_request` from a fork is read-only. A same-repository pull request is not a fork. Do not put an LLM secret in that workflow until the action is pinned to a tag the owner trusts.
- `rank` and a local `check` without `--skip-llm` send paths, titles, reasons, and test statuses to the provider when ranking is on. They do not send file bodies or diff hunks. A hostile title can still waste the call. The answer is rejected unless it is an exact reorder.
- GitHub comment rendering (mentions, autolinks, the hidden marker in the job summary) is still a live check. Unit tests cover the Markdown the tool writes, not GitHub's renderer.
- The action's "build dist when missing" step runs `npm ci` inside the action directory. That is the action's own package, which a pull request can change when `uses: ./`.
- `ci.yml` and `prcheck.yml` pin actions by major tag (`@v7`), not by commit SHA.
- No Windows or macOS CI job is configured. Path handling uses Node's `path` and git. It was not executed on those systems here.
- There is no ESLint script. `npm run typecheck` is the static check.
