# Release acceptance

Checklist for version 0.2.0, released on 2026-11-09 (npm `@sprintsynergy/qa-core-prcheck@0.2.0`, tag `v0.2.0`), and for 0.2.1, a docs-only patch of it (tag `v0.2.1`). This file is not a claim that a pull request is safe to merge.

Product rules that stay in force:

- Selection is rule-first. A file that no rule maps runs the full suite.
- The result is advisory. A failed test does not fail the action unless `fail-on-test-failure` is true. A pass is not a safe-merge guarantee.
- LLM ranking is off unless a workflow sets `llm: true` and passes a key. It cannot add, remove, or run a spec, and it cannot change the verdict or the exit code.
- This repo's pull request workflow does not pass an LLM secret. It uses `uses: ./`.
- The GitHub Action is Linux-only. The CLI is what Windows and macOS CI run.

## Comment and job summary evidence

Checked against pull request 1, comment 6726882681, from the successful run on `ubuntu-24.04` (actions run 42521610240), by reading the API and the uploaded artifact. This was not a browser session.

- The artifact `prcheck-summary.md` starts with the marker `<!-- qa-core-prcheck:summary -->`.
- GitHub's rendered comment HTML (`Accept: application/vnd.github.html+json`) does not contain that marker and does not contain `<!--`. The body starts at `<h2>PR Check: Passed (Full Suite Run)</h2>`. The counts table rendered as a table. The footer text is present.
- That comment's tests are the demo titles. They do not contain `@`, `#1`, `GH-1`, `$`, or a URL. So this comment does not prove those escapes in GitHub's renderer.
- `npm run eval` checks the bytes the tool would write for `@sardar-usman`, `#1`, `GH-1`, `sprintsynergyio/qa-core-prcheck#1`, `$x$`, and a URL whose hash must stay raw. That is the local contract, not a screenshot.
- The job summary page was not available from the API or the artifact. The rank step is what appends it. Whether that page hides the marker has not been seen.

Visual checks, and which of them block a merge:

- The marker in a pull request comment is already confirmed on comment 6726882681. No further comment-page inspection is required for that.
- The job summary page is still unseen. The marker is an HTML comment, and the comment renderer already hid it. Looking at one job summary is optional follow-up, not a merge blocker.
- A throwaway pull request for live `@`, `#1`, `GH-1`, `$`, and URL titles is optional follow-up. `npm run eval` checks those bytes. No such pull request has been made.

## Release checklist

- [x] Rules still decide selection, verdict, and exit code.
- [x] LLM stays off in this repo's workflow.
- [x] Fork path stays `pull_request` only, with `comment: false` for forks and Dependabot, checkout `persist-credentials: false`. `npm test` and `npm run eval` run the same-repo, fork, null-head, and Dependabot decisions. A live fork workflow run was not created.
- [x] Config cannot name the key env var, raise the timeout past 30 minutes, or raise the LLM attempt cap.
- [x] Check and rank unset the job token and runtime token before Node. The comment step still gets its token.
- [x] `npm run eval` is in CI and prints pass or fail per case, not a model score.
- [x] CLI CI is scheduled on Linux, Windows, and macOS. Record the run URLs on the pull request after they finish.
- [x] Fork comment guards are executed locally: same-repo versus fork, null head, case mismatch, and Dependabot. The live fork end-to-end path is unexercised and is not a merge blocker.
- [ ] Optional follow-up, not a merge blocker: glance at one job summary, and only if wanted, a throwaway pull request for the live escape titles above.
- [x] Tagged `v0.2.0` at `16eaee6` and published to npm on 2026-11-09.
- [x] The published action tag runs from a workflow, builds its own CLI, and keeps one sticky comment across pushes. See Published action evidence.
- 0.2.1 release steps, done by the owner: merge, tag `v0.2.1` at the merge commit, publish to npm, and create the GitHub Release. A workflow that sets `llm: true` with a real key pins `sprintsynergyio/qa-core-prcheck@v0.2.1`.

## Published action evidence

Checked on 2026-11-09 on draft pull request #3 (E2E proof, not merged), with a workflow that uses `sprintsynergyio/qa-core-prcheck@v0.2.0`, not `uses: ./`, on `ubuntu-24.04`, by reading the API and the job logs:

- The runner downloaded the action at `16eaee6`. The tag has no `dist/`, so the action's first step ran `npm ci` and `npm run build` in the action folder.
- Run 42617287988 (a `cart-page.ts` change): 2 of 4 specs picked, each with the reason `demo/saucedemo/pages/cart-page.ts is imported by <spec>`, 4 of 4 tests passed, exit code 0, verdict `passed`, and `Comment created` for comment 6740072262.
- Run 42617704273 (a second push, adding a `login-page.ts` change): 4 of 4 specs picked, 8 of 8 tests passed, and `Comment updated` for the same comment 6740072262. The pull request still has one comment, from `github-actions[bot]`, type `Bot`.
- The published npm CLI `@sprintsynergy/qa-core-prcheck@0.2.0`, installed fresh, gave the same selection and a passed check on the same diff on a Linux machine.
- The job summary page cannot be read through the API, so it is still unseen.

## Still out of scope

- A quality score for the picker or for an LLM.
- Making a failed test fail the job by default.
- Per-test selection, tsconfig path aliases, and runtime data files.
- Running the GitHub Action on Windows or macOS.
- Installing Chromium on `ubuntu-latest` while Playwright stays at 1.60.0.
