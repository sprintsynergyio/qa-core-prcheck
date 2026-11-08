# qa-core-prcheck

A CI agent for GitHub Actions that reads a pull request diff, picks the Playwright tests the change can affect, runs only those, suggests missing tests and posts one pass or fail summary before merge.

## Status

Version 0.2.0 is the version in this tree. It is not published yet. The npm registry still has 0.1.0 until the owner publishes. See [CHANGELOG.md](CHANGELOG.md). The CLI lists the files a change touches, picks the Playwright specs the change can affect with a written reason for each pick, runs only those specs with a typed pass or fail result and exit code, suggests missing tests, and writes one Markdown summary. The GitHub Action runs this on every pull request of this repo and keeps the summary in one sticky PR comment. Optional LLM ranking (Anthropic, OpenAI or Gemini) is off by default and advisory: the rules still decide what runs, the verdict and the exit code. In the action, ranking is a later step that runs only after Playwright has exited, and only when the workflow sets `llm: true`. See LLM Ranking (Optional) and [docs/release-acceptance.md](docs/release-acceptance.md).

## Requirements

- Node 22.6 or later
- `@playwright/test` 1.60.0 or later in the repository that holds your tests (a peer dependency)
- git, needed for the `diff`, `select`, `run` and `check` commands with `--base`
- Chromium for Playwright, only needed to run the demo suite, directly or through `run` or `check`
- A GitHub token with `pull-requests: write`, only for the `comment` command; GitHub Actions provides it
- The `qa-core-prcheck` command is the supported surface on Linux, Windows, and macOS. The GitHub Action is Linux-only: its steps are bash, and this repo runs it on `ubuntu-24.04` because Playwright 1.60.0 cannot install Chromium on the current `ubuntu-latest` image. Windows and macOS CI runs the CLI, the rule eval, and a packed-package smoke test. It does not install a browser.

## Install

Install it as a dev dependency in the repository that holds your Playwright tests. It uses that repository's own `@playwright/test`. `@playwright/test` 1.60.0 or later is a peer dependency: 1.60.0 is the version this tool is tested against, and the Playwright behavior described below was checked in that version.

```bash
npm install --save-dev @sprintsynergy/qa-core-prcheck
npx qa-core-prcheck --version
```

Then add `qa-core-prcheck.config.json` at the repository root and set `playwrightDir` to the folder that holds your `playwright.config.ts`, relative to the root. Use `.` when it is at the root:

```json
{ "playwrightDir": "." }
```

Without this file the tool looks in `demo/saucedemo`, the demo suite in this repo, and exits 2 with `Playwright folder not found: demo/saucedemo`. See Config File for the other keys.

```bash
npx qa-core-prcheck check --base origin/main   # pick, run and summarize the tests for the current branch
```

The command is `qa-core-prcheck` (no scope). Every `node dist/cli.js` example below works the same as `npx qa-core-prcheck` once the package is installed.

## Quick Start

To work on this repo itself:

```bash
npm ci                            # install pinned dependencies
npx playwright install chromium   # browser for the demo suite
npm run demo:list                 # list the demo tests and their tags
npm run demo:test                 # run the demo suite against SauceDemo
npm test                          # build, then run the unit tests
```

## Demo Suite

[SauceDemo](https://www.saucedemo.com) is a public practice site and not our code. The suite in `demo/saucedemo/` gives later PRs a small, real Playwright project to pick tests from.

| Feature Folder | Tag | Covers |
| --- | --- | --- |
| `tests/login/` | `@login` | Standard login and the locked out user error |
| `tests/inventory/` | `@inventory` | Sorting products by price and by name |
| `tests/cart/` | `@cart` | Adding and removing a product |
| `tests/checkout/` | `@checkout` | Completing an order and the required first name check |

Layout rules:

- One Page Object per feature in `pages/<feature>-page.ts`, with a PascalCase class.
- One spec per feature in `tests/<feature>/<feature>.spec.ts`, wrapped in one `test.describe` with its feature tag.
- The cart and checkout specs both import `CartPage`, so a change to it affects both.
- Retries stay at 0 so a flaky test is never hidden.
- The only credentials are the public demo ones printed on the SauceDemo login page.

Run one feature by tag:

```bash
npx playwright test -c demo/saucedemo/playwright.config.ts --grep @cart
```

## Diff Command

Lists the files changed between two git refs, or in a saved diff file. It does not pick or run tests.

```bash
npm run build
node dist/cli.js diff --base origin/main                  # from the merge base of origin/main and HEAD, to HEAD
node dist/cli.js diff --base origin/main --head feature   # the same, with a chosen head ref
node dist/cli.js diff --diff-file changes.diff --json     # a saved git diff, printed as JSON
```

| Option | Meaning |
| --- | --- |
| `--base <ref>` | Compare against the merge base of this ref and the head |
| `--head <ref>` | The head ref (default: `HEAD`) |
| `--diff-file <path>` | Read a saved unified git diff instead of running git |
| `--json` | Print JSON instead of text |

Exactly one of `--base` and `--diff-file` is required, and `--head` only works with `--base`. Values follow their option as a separate argument.

With `--base`, the diff starts at the merge base of the two refs, so commits that landed on the base branch after the fork point are not listed. The list is sorted by path, and every path is repo-relative with forward slashes.

Text output for `tests/fixtures/diffs/mixed.diff`:

```text
Changed files: 10
modified  .github/workflows/ci.yml  +1 -0  ci-workflow
modified  .nvmrc  +1 -1  other
modified  README.md  +1 -1  docs
modified  demo/saucedemo/fixtures/users.ts  +1 -0  test-data
modified  demo/saucedemo/pages/cart-page.ts  +1 -1  test-support
modified  demo/saucedemo/playwright.config.ts  +1 -1  playwright-config
modified  demo/saucedemo/tests/cart/cart.spec.ts  +1 -1  spec
modified  package-lock.json  +1 -1  lockfile
modified  package.json  +1 -1  package-manifest
modified  src/cli.ts  +1 -1  app-source
```

With `--base`, a `Merge base: <sha>` line comes first. A renamed or copied file shows as `<oldPath> -> <path>`, and a binary file shows `binary` instead of the line counts.

### Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Ok, whether or not any files changed |
| 2 | Usage or tool error: the message goes to stderr and stdout stays empty |
| 1 | Never used by diff; only run and check exit 1, when a picked test fails |

### JSON Shape

`--json` prints one object, with keys always in this order:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1` |
| `source` | `{ type: "git", base, head, baseSha, headSha, mergeBaseSha }` or `{ type: "file", path }`, with refs and path exactly as given |
| `files[].path` | Repo-relative path in the new tree; for a deleted file, the path it had |
| `files[].oldPath` | The old path for renamed and copied files, otherwise `null` |
| `files[].status` | `added`, `modified`, `deleted`, `renamed` or `copied` |
| `files[].similarity` | Percent from git's similarity index for renamed and copied files, otherwise `null` |
| `files[].binary` | `true` for binary files, which have no line counts or ranges |
| `files[].additions`, `files[].deletions` | Added and removed line counts |
| `files[].ranges` | Added lines in the new file as inclusive, 1-based `{ start, end }` ranges |
| `files[].fileClass` | One of the file classes below |

Real output of `node dist/cli.js diff --diff-file tests/fixtures/diffs/rename-with-edits.diff --json`:

```json
{
  "schemaVersion": 1,
  "source": {
    "type": "file",
    "path": "tests/fixtures/diffs/rename-with-edits.diff"
  },
  "files": [
    {
      "path": "demo/saucedemo/pages/order-page.ts",
      "oldPath": "demo/saucedemo/pages/checkout-page.ts",
      "status": "renamed",
      "similarity": 87,
      "binary": false,
      "additions": 3,
      "deletions": 1,
      "ranges": [
        {
          "start": 3,
          "end": 3
        },
        {
          "start": 10,
          "end": 10
        },
        {
          "start": 19,
          "end": 19
        }
      ],
      "fileClass": "test-support"
    }
  ]
}
```

### File Classes

Built-in rules on the path, case sensitive. The first match wins. "Folder" means a folder name in the path, not the file name.

| Class | Rule |
| --- | --- |
| `ci-workflow` | Path starts with `.github/workflows/` or `.github/actions/` |
| `lockfile` | File name is `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` or `bun.lockb` |
| `package-manifest` | File name is `package.json` |
| `playwright-config` | File name like `playwright.config.ts` or `playwright.ct.config.mjs` (`ts`, `js`, `mjs`, `cjs`, `mts`, `cts`) |
| `spec` | File name ends in `.spec.` or `.test.` plus `ts`, `tsx`, `js`, `jsx`, `mjs`, `cjs`, `mts` or `cts` |
| `test-data` | A folder is `fixtures`, `test-data` or `testdata` |
| `docs` | Extension `.md`, `.mdx`, `.markdown`, `.txt` or `.rst`; or the file name starts with `LICENSE`; or the first folder is `docs` |
| `test-support` | A folder is `tests`, `test`, `e2e` or `__tests__`; or a folder is `pages`, `page-objects`, `helpers` or `support` and another folder is `demo` |
| `app-source` | Extension `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.vue`, `.svelte`, `.css`, `.scss` or `.html` |
| `other` | Everything else, for example `.nvmrc`, `tsconfig.json` or images. It means unknown: the `select` command treats these files as unmapped unless an earlier rule or the config covers them |

### Shallow Clones

The git source needs the merge base of the two refs. `actions/checkout` fetches only the latest commit by default, so the fork point is often missing in CI. The command then exits 2 with a message that says so. Fix it by setting `fetch-depth: 0` on `actions/checkout`, or by running `git fetch --unshallow`.

### Limits

- Only the `a/` and `b/` path prefixes are read from a saved diff. A diff made with `--no-prefix` or other prefixes is rejected.
- Copy detection is off for the git source, so `copied` only appears when a saved diff contains it.
- Combined diffs (`diff --cc`, from merge commits) are not supported.
- `ranges` lists added lines only. A hunk that only deletes lines adds no range.
- File classes come from built-in rules. The `select` config file does not change them.

## Select Command

Picks the Playwright specs a change can affect and gives a written reason for every pick. It does not run any test. The rules are fixed and run locally: no network, no API key.

```bash
npm run build
node dist/cli.js select --base origin/main                  # the change from the merge base of origin/main and HEAD
node dist/cli.js select --base origin/main --head feature   # the same, with a chosen head ref
node dist/cli.js select --diff-file changes.diff --json     # a saved git diff, printed as JSON
```

| Option | Meaning |
| --- | --- |
| `--base <ref>` | Compare against the merge base of this ref and the head |
| `--head <ref>` | The head ref (default: `HEAD`) |
| `--diff-file <path>` | Read a saved unified git diff instead of running git |
| `--root <dir>` | The repository root (default: the current folder) |
| `--json` | Print JSON instead of text |

The option rules are the same as for `diff`: exactly one of `--base` and `--diff-file`, `--head` only with `--base`, and values follow their option as a separate argument. git runs in `--root`. A relative `--diff-file` path is read from the current folder. With `--base`, the merge base and shallow clone notes of the `diff` command apply.

The command reads the diff, then `qa-core-prcheck.config.json`, then finds the Playwright folder and its config file. Only then does it run `playwright test --list --reporter=json`, so a bad ref or a bad config fails before Playwright starts. Listing tests needs no browser. Playwright runs through `execFile` with an argument array, with `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, `BUILD_URL`, `PW_TEST_REPORTER` and the `PLAYWRIGHT_JSON_OUTPUT_*` variables removed from its environment; `CI` is passed through (see Run Limits). Last, the command builds the import graph, applies the rules and adds the suggested tests (see Suggested Tests under Check Command).

### Select Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Ok, in every mode, including `full` |
| 2 | Usage or tool error: the message goes to stderr and stdout stays empty |
| 1 | Never used by select; only run and check exit 1, when a picked test fails |

### Modes

| Mode | Meaning |
| --- | --- |
| `none` | No changed file can affect a test, for example a docs-only change. Nothing needs to run |
| `subset` | Only the listed specs can be affected |
| `full` | At least one changed file can affect any test, or no rule maps it. Every spec is listed, and `fullSuiteReasons` says why |

### Rules

Each changed file goes through the rules in this order, and the first rule that matches decides it. The old path of a renamed file is checked too, as a deleted file; for a spec it gets its own reason, so a rename never reads as a deletion. A copied file is checked by its new path only, because its source still exists.

| Rule | When | Outcome |
| --- | --- | --- |
| 1. Ignore | The path matches an `ignore` glob. This beats every other rule, including a lockfile | `ignored` |
| 2. Full suite trigger | A Playwright config, `package.json`, lockfile or CI workflow file, or a `fullSuiteOn` glob match | `full` |
| 3. Changed spec | A spec in the Playwright inventory that was not deleted | The spec, plus every spec that imports it |
| 4. Used by the config | The Playwright config imports the file, directly or through other files | `full` |
| 5. Imported by specs | One or more specs import the file, directly or through other files | Those specs |
| 6. Deleted support file | A deleted or renamed away `test-support` or `test-data` file. Skipped for the old path of a rename whose new path rule 5 maps | `full` |
| 7. Spec outside the inventory | A `spec` class file that Playwright does not list: a deleted spec (`Spec deleted, nothing to run: <path>`), the old path of a renamed spec (`Spec renamed: <old> to <new>`), or any other spec Playwright does not list (`Not in the Playwright inventory: <path>`) | `none` |
| 8. Unreached support script | A `test-support` or `test-data` script (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`) that no spec imports | `none` |
| 9. Areas | The path matches one or more `areas` globs | The specs with a test that has one of their tags, or `full` when no test has any |
| 10. Docs | A `docs` class file | `none` |
| 11. Unmapped | Anything else | `full` |

Specs and imports are decided from the real inventory and the import graph first. The file class only matters after that, so a Page Object outside a demo folder (class `app-source`) is still mapped by rule 5 when a spec imports it.

Rule 8 comes before rule 9, so an area cannot pick specs for a support script that no spec imports. Support and data files that are not scripts, such as JSON or images, skip rule 8, because a test may read them at run time.

Each selected spec lists why it was picked, for example `<file> is imported by <spec>` or `<file> is imported by <spec> through <a> -> <b>`. The chain is the shortest import path from the spec, and when several exist, the one that sorts first. In mode `full`, every spec is listed and its last reason is `Part of the full suite run`.

### Config File

`qa-core-prcheck.config.json` at the root is optional, and so is every key in it:

```json
{
  "playwrightDir": "demo/saucedemo",
  "areas": { "demo/saucedemo/pages/cart-page.ts": ["@cart"] },
  "fullSuiteOn": ["demo/saucedemo/fixtures/**"],
  "ignore": ["docs/**", "**/*.md"],
  "llm": { "provider": "none" }
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `playwrightDir` | The folder with the Playwright config, relative to the root. `.` means the root | `demo/saucedemo` |
| `areas` | Maps a glob to a list of tags. Each tag starts with `@`, as written in the specs | none |
| `fullSuiteOn` | Globs that run the full suite | none |
| `ignore` | Globs that are ignored | none |
| `llm` | Optional LLM ranking for `check` only: `{ provider, model }`. See LLM Ranking (Optional) | provider `none` (off) |

These problems exit 2 with a message that names the file and the key:

- the file is not valid JSON, or its top level is not an object
- a key other than the five above
- `playwrightDir` is not a non-empty string, is absolute, or has a `..` folder
- `areas` is not an object, has an empty glob, or maps a glob to anything other than a non-empty list of tags that start with `@`
- `fullSuiteOn` or `ignore` is not a list of non-empty strings

`select`, `run` and `diff` accept the `llm` key and ignore what is in it. `check` and `rank` read and check it, so a bad `llm` object makes `check` exit 2 before any test runs; its messages are listed in LLM Ranking (Optional).

`playwrightDir` is normalized: `./demo/x/` becomes `demo/x`. Areas are sorted by glob, and tags and lists are sorted with duplicates removed. The file is refused over 65536 bytes. `playwrightDir` is at most 200 characters and has no control characters. `areas` has at most 100 globs, each with at most 20 tags; a tag is `@` plus 1 to 63 characters and no whitespace. `fullSuiteOn` and `ignore` have at most 100 globs, each at most 300 characters, with no control characters, and with at most 8 `*` characters so a glob cannot make matching take unbounded time. The config file must be a regular file, not a symlink. A glob or tag that fails these limits exits 2 with a message that names the key. The pull request config cannot raise the limits, name an API key env var, or set the Playwright kill timeout.

The Playwright config file is the first of `playwright.config.ts`, `.js`, `.mts`, `.mjs`, `.cts` and `.cjs` found in `playwrightDir`. That is the order Playwright itself uses.

### Glob Syntax

Globs match repo-relative paths with forward slashes. Matching is case sensitive and must cover the whole path.

| Pattern | Matches |
| --- | --- |
| `*` | Any run of characters except `/` |
| `**` | Any run of characters, including `/` |
| `**/` | At the start or after a `/`: zero or more whole folders |
| `?` | One character except `/` |

Every other character is literal. There are no braces, negation or character classes. `*.md` matches `README.md` but not `docs/a.md`, and `**/*.md` matches both. `docs/**` matches `docs/a.md` and `docs/x/y.md` but not `docs`.

### Text Output

Real output of `node dist/cli.js select --diff-file tests/fixtures/diffs/modify.diff`:

```text
Mode: subset
Selected specs: 2 of 4
  demo/saucedemo/tests/cart/cart.spec.ts
    - demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/cart/cart.spec.ts
  demo/saucedemo/tests/checkout/checkout.spec.ts
    - demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/checkout/checkout.spec.ts
Changed files: 1
specs    demo/saucedemo/pages/cart-page.ts  Used by spec files: 2
```

With `--base`, a `Merge base: <sha>` line comes first. In mode `full`, a `Full suite reasons:` block follows the specs. A `Warnings:` block follows the changed files when there are warnings. A `Suggested tests: <n>` block comes last when there are suggestions, with one line for each: `- <file>: <idea>`, indented by two spaces.

Real output of `node dist/cli.js select --diff-file tests/fixtures/diffs/add.diff`:

```text
Mode: none
Selected specs: 0 of 4
Changed files: 1
none     demo/saucedemo/pages/wishlist-page.ts  No spec imports demo/saucedemo/pages/wishlist-page.ts
Suggested tests: 1
  - demo/saucedemo/pages/wishlist-page.ts: Add a spec that imports demo/saucedemo/pages/wishlist-page.ts and uses it, or remove the file if nothing needs it.
```

### Select JSON Shape

`--json` prints one object, with keys always in this order:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1` |
| `source` | The diff source, as in the `diff` command |
| `mode` | `none`, `subset` or `full` |
| `playwrightDir` | The Playwright folder from the config |
| `totalSpecs`, `totalTests` | Counts in the Playwright inventory. A test that runs in two projects counts once |
| `selected[]` | `{ file, testCount, tags, reasons }`, sorted by file. In mode `full` this is every spec |
| `fullSuiteReasons` | Why the full suite runs, sorted. Empty unless the mode is `full` |
| `decisions[]` | `{ path, fileClass, status, outcome, reason, specs }`: one per changed path and one per rename old path, sorted by path, then status. `outcome` is `ignored`, `none`, `specs` or `full` |
| `warnings` | Import graph warnings, for example `Unresolved import "<specifier>" in <file>`, sorted |
| `suggestions[]` | `{ file, kind, reason, idea }`: missing test suggestions, sorted by file, then kind, then reason. `kind` is `unmapped-file`, `unimported-support`, `untagged-area` or `unused-member`. Always present, an empty list when there are none, and every suggestion is listed. They are advisory and never change the fields above (see Suggested Tests) |

Tags are written as in the source, with the `@`. Playwright's JSON list drops the `@`, and the inventory puts it back. Lists are sorted in plain code unit order and there are no timestamps, so the same input gives byte identical output.

Real output of `node dist/cli.js select --diff-file tests/fixtures/diffs/modify.diff --json`:

```json
{
  "schemaVersion": 1,
  "source": {
    "type": "file",
    "path": "tests/fixtures/diffs/modify.diff"
  },
  "mode": "subset",
  "playwrightDir": "demo/saucedemo",
  "totalSpecs": 4,
  "totalTests": 8,
  "selected": [
    {
      "file": "demo/saucedemo/tests/cart/cart.spec.ts",
      "testCount": 2,
      "tags": [
        "@cart"
      ],
      "reasons": [
        "demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/cart/cart.spec.ts"
      ]
    },
    {
      "file": "demo/saucedemo/tests/checkout/checkout.spec.ts",
      "testCount": 2,
      "tags": [
        "@checkout"
      ],
      "reasons": [
        "demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/checkout/checkout.spec.ts"
      ]
    }
  ],
  "fullSuiteReasons": [],
  "decisions": [
    {
      "path": "demo/saucedemo/pages/cart-page.ts",
      "fileClass": "test-support",
      "status": "modified",
      "outcome": "specs",
      "reason": "Used by spec files: 2",
      "specs": [
        "demo/saucedemo/tests/cart/cart.spec.ts",
        "demo/saucedemo/tests/checkout/checkout.spec.ts"
      ]
    }
  ],
  "warnings": [],
  "suggestions": []
}
```

### Select Limits

- Selection is per spec file, not per test.
- Only relative imports are followed. tsconfig paths and package aliases are not.
- `import(variable)` and `require(variable)` cannot be seen. Only a plain string argument is.
- Files read at run time, such as data files and images, are not tracked. They run the full suite unless an area or an ignore pattern covers them.
- A changed file that no rule maps runs the full suite.
- `--root` must be the repository root, because diff paths are relative to it.
- The inventory and the import graph are read from the files under `--root`, so that checkout should be the head of the diff. If another commit is checked out, the result reflects that checkout.
- Areas come after rule 8, so an area cannot pick specs for a support script that no spec imports.
- Playwright leaves a spec file with no tests out of its list, so such a file is not in the inventory. A Playwright folder with no tests at all exits 2 with `No tests found`.
- The config file keys are `playwrightDir`, `areas`, `fullSuiteOn`, `ignore` and `llm`. `select` accepts `llm` and does not read it. Counts and lengths are capped; see Config File.
- The command prints JSON to stdout and does not write an artifact file yet.

## Run Command

Picks the Playwright specs a change can affect with the `select` rules, runs only those, reads Playwright's JSON report and prints one result with an exit code. A change that no rule can map runs the full suite, as in `select`.

```bash
npm run build
node dist/cli.js run --base origin/main                   # run what the change from the merge base can affect
node dist/cli.js run --diff-file changes.diff --json      # a saved git diff, result as JSON
node dist/cli.js run --diff-file changes.diff --dry-run   # print the Playwright command, run no test
```

### Run Usage

| Option | Meaning |
| --- | --- |
| `--base <ref>` | Compare against the merge base of this ref and the head |
| `--head <ref>` | The head ref (default: `HEAD`) |
| `--diff-file <path>` | Read a saved unified git diff instead of running git |
| `--root <dir>` | The repository root (default: the current folder) |
| `--timeout-minutes <n>` | Kill timeout for the Playwright run, a whole number from 1 to 30 (default: 30). The config file cannot set it |
| `--json` | Print JSON instead of text |
| `--dry-run` | Print the Playwright command without running it |

The option rules are the same as for `select`. `--dry-run` is a flag and may be given once.

What happens:

1. The command reads the diff and picks the specs, exactly as `select` does. This step runs `playwright test --list`, which needs no browser.
2. In mode `none`, nothing else starts and the result is `nothing to run`.
3. With `--dry-run`, the command is printed and no test runs.
4. Otherwise it runs `playwright test --config <playwrightDir> --reporter=json --pass-with-no-tests --forbid-only`, plus one file filter per selected spec in mode `subset`. Mode `full` has no filter.

Playwright reads each file filter as a regular expression and matches it against absolute file paths, so a plain `tests/cart/cart.spec.ts` would also match `tests/cart/cart.spec.tsx` or `other/tests/cart/cart.spec.ts`. Each filter is therefore `/^<absolute spec path>$/` with every special character escaped: anchored at both ends, case sensitive, and matching exactly one file. Output shows the absolute root as `<root>`.

Playwright runs through `execFile` with an argument array. `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, `BUILD_URL`, `PW_TEST_REPORTER` and the `PLAYWRIGHT_JSON_OUTPUT_*` variables are removed from its environment, `CI` is passed through, and `PLAYWRIGHT_JSON_OUTPUT_FILE` is set to a file in a new temp folder (`prcheck-run-*`), which is removed when the run ends. `--reporter=json` replaces the reporters in the Playwright config for this run, so an html report is not written. Playwright still writes its own output folder (`test-results`).

### Focused Tests

Every Playwright run passes `--forbid-only`: the `--list` run that reads the inventory and the test run alike. In Playwright 1.60.0 the flag overrides the config's `forbidOnly` (`lib/common/index.js:564`), and the list run checks it too (`lib/runner/index.js:2436-2441`). So any `test.only` or `describe.only` in the Playwright project is an error, exit 2, in every environment and every mode: `select`, `run` and `check` stop before any test runs, and a focused test can never give `Passed`.

Real output of `node dist/cli.js check --diff-file tests/fixtures/diffs/mixed.diff --root <project> --summary-file s.md` on the made-up project in `tests/fixtures/results/README.md`, with a spec `tests/focus/focus.spec.ts` that has one `test.only`; stderr, exit code 2, the same with and without `CI=true`:

```text
Playwright reported an error: Error: item focused with '.only' is not allowed due to the '--forbid-only' CLI flag: "focus/focus.spec.ts adds a backpack"
Run qa-core-prcheck check --help for usage.
```

and the summary it wrote:

```markdown
<!-- qa-core-prcheck:summary -->
## PR Check: Error

The check could not finish, so the test result is unknown. See Errors below.

### Errors
- Playwright reported an error: Error: item focused with '.only' is not allowed due to the '--forbid-only' CLI flag: "focus/focus.spec.ts adds a backpack"

---
_Advisory check, exit code 2. qa-core-prcheck 0.0.1._
```

### Run Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Every picked test passed, flaky tests included; or nothing needed to run; or `--dry-run` |
| 1 | A picked test failed, timed out or was interrupted |
| 2 | Usage or tool error |

The first matching rule decides the result:

1. Playwright could not start, was stopped by the kill timeout or a signal, wrote no JSON report or one that is not valid, or reported top-level errors, for example a spec that fails to load: `error`, exit 2.
2. A test failed, timed out or was interrupted: `failed`, exit 1.
3. Playwright exited non-zero but no test failed: `error`, exit 2, with `Playwright exited with code <n> but no test failed`.
4. Otherwise: `passed`, exit 0.

A usage error, or an error before Playwright starts (a bad ref, a bad config file), prints the message on stderr and leaves stdout empty. An `error` result after Playwright started prints the full result on stdout, and its first error also on stderr.

### Run Output

Real output of `node dist/cli.js run --diff-file tests/fixtures/diffs/modify.diff --dry-run`, exit code 0. A run against the live SauceDemo site prints the same command, then `Tests` and `Duration` lines instead of `not run`; it was not repeated for this PR.

```text
Mode: subset
Specs: 2
Command: playwright test --config demo/saucedemo --reporter=json --pass-with-no-tests --forbid-only /^<root>/demo/saucedemo/tests/cart/cart\.spec\.ts$/ /^<root>/demo/saucedemo/tests/checkout/checkout\.spec\.ts$/
Result: not run (dry run)
```

Real output of a run with failures, on the made-up project in `tests/fixtures/results/README.md` with `mixed.diff` (mode `full`), exit code 1:

```text
Mode: full
Specs: 2
Command: playwright test --config demo/shop --reporter=json --pass-with-no-tests --forbid-only
Result: failed
Tests: 7 total, 3 passed, 1 failed, 1 flaky, 1 skipped, 1 timed out, 0 interrupted
Duration: 1.7s
Failures:
  failed  demo/shop/tests/checkout/checkout.spec.ts:4  checkout > counts the items in the cart [desktop]
    Error: expect(received).toBe(expected) // Object.is equality
  timedOut  demo/shop/tests/checkout/checkout.spec.ts:9  checkout > waits for the payment page [desktop]
    Test timeout of 500ms exceeded.
Flaky:
  demo/shop/tests/cart/cart.spec.ts:9  cart > shows the badge after a retry [desktop]
```

With `--base`, a `Merge base: <sha>` line comes first. Mode `none` prints `No specs were selected, so no tests ran.` instead of the command and counts, and `--dry-run` prints no `Tests` or `Duration` line. `Errors:` and `Warnings:` blocks come last when they are not empty.

Each test entry gets one status, from Playwright's status for the test and its last attempt, in this order:

| Status | When |
| --- | --- |
| `flaky` | Playwright says flaky: an attempt failed and a retry passed. It does not fail the run |
| `passed` | Playwright says expected, including a `test.fail()` test that failed as expected |
| `interrupted` | The last attempt was interrupted. Playwright itself calls such a test skipped |
| `skipped` | Playwright says skipped |
| `timedOut` | Playwright says unexpected and the last attempt timed out |
| `failed` | Playwright says unexpected otherwise |

### Run JSON Shape

`--json` prints one object, with keys always in this order:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1` |
| `source`, `mode`, `playwrightDir` | As in the `select` JSON |
| `specs` | The spec files run: the selected specs in mode `subset`, every spec in mode `full`, none in mode `none` |
| `command` | The Playwright arguments with the root shown as `<root>`, or `null` in mode `none` |
| `verdict` | `passed`, `failed`, `nothing-to-run`, `not-run` (dry run) or `error` |
| `exitCode` | `0`, `1` or `2` |
| `counts` | `{ total, passed, failed, flaky, skipped, timedOut, interrupted }` over `tests` |
| `durationMs` | Playwright's own run duration, rounded; `0` when nothing ran |
| `tests[]` | `{ file, line, title, project, tags, status, attempts, durationMs, error }`, one per test and project, sorted by file, line, title and project |
| `errors` | Top-level Playwright errors and tool problems, one line each, in the order found |
| `warnings` | The selection warnings plus runner warnings such as `No tests ran for the selected specs`, sorted |

In `tests[]`, `title` joins the describe titles and the test title with `>` and a space on each side, as the inventory does, `tags` keep the `@`, `attempts` is the number of attempts Playwright recorded, and `durationMs` is their sum. `error` is the first line of the last failing attempt's error, with color codes removed and paths made repo-relative; it is `null` for passed and skipped tests. A top-level error that has a location inside the root and does not name its file starts with `<file>:<line>:` and a space.

Real output of `node dist/cli.js run --diff-file tests/fixtures/diffs/modify.diff --dry-run --json`:

```json
{
  "schemaVersion": 1,
  "source": {
    "type": "file",
    "path": "tests/fixtures/diffs/modify.diff"
  },
  "mode": "subset",
  "playwrightDir": "demo/saucedemo",
  "specs": [
    "demo/saucedemo/tests/cart/cart.spec.ts",
    "demo/saucedemo/tests/checkout/checkout.spec.ts"
  ],
  "command": [
    "test",
    "--config",
    "demo/saucedemo",
    "--reporter=json",
    "--pass-with-no-tests",
    "--forbid-only",
    "/^<root>/demo/saucedemo/tests/cart/cart\\.spec\\.ts$/",
    "/^<root>/demo/saucedemo/tests/checkout/checkout\\.spec\\.ts$/"
  ],
  "verdict": "not-run",
  "exitCode": 0,
  "counts": {
    "total": 0,
    "passed": 0,
    "failed": 0,
    "flaky": 0,
    "skipped": 0,
    "timedOut": 0,
    "interrupted": 0
  },
  "durationMs": 0,
  "tests": [],
  "errors": [],
  "warnings": []
}
```

Durations are Playwright's measurements and change between runs. Everything else is sorted and has no timestamps, so the same input and the same test results give the same output.

### Run Limits

- Specs run per file: every test in a selected spec runs.
- The JSON report is read from a temp file and not kept.
- Playwright's own console output is not shown.
- `error` is one line. For an `expect()` failure that is the matcher line; the expected and received values are on later lines and are not included. Error lines are cut at 200 characters.
- The kill timeout defaults to 30 minutes. `run` and `check` take `--timeout-minutes` from 1 to 30. The action input `timeout-minutes` uses the same range. A value outside it is a usage error, exit 2, and no test starts. The config file has no timeout key, because that file comes from the pull request under check.
- Git capture is turned off by removing `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL` and `BUILD_URL`, the only variables Playwright 1.60.0 checks before it runs git (`lib/runner/index.js:653-685`); with `GITHUB_ACTIONS` and a pull request event it would also run `git fetch`. `CI` alone starts no git, and a `--list` run never does. A Playwright config that sets `captureGitInfo` itself still makes Playwright run git.
- `CI` is passed through, so a config that reads `process.env.CI` behaves as it does in CI. In the demo config that means `forbidOnly` is on in CI (the flag already forces it) and 2 workers in CI instead of Playwright's default. The worker count changes only how long the run takes: the result is sorted, so only durations differ. With `CI` set, Playwright's own progress output is `dot` instead of `line`; it is not read.

## Check Command

Does `diff`, `select` and `run` in one step and writes one Markdown summary that a reviewer can read in seconds. The `comment` command posts that summary as the sticky PR comment; see Comment Command.

```bash
npm run build
node dist/cli.js check --base origin/main                  # check the change, write prcheck-summary.md
node dist/cli.js check --diff-file changes.diff --json     # a saved git diff, the full result as JSON
node dist/cli.js check --diff-file changes.diff --dry-run  # the summary of what would run; no test, no file
```

### Check Usage

| Option | Meaning |
| --- | --- |
| `--base <ref>` | Compare against the merge base of this ref and the head |
| `--head <ref>` | The head ref (default: `HEAD`) |
| `--diff-file <path>` | Read a saved unified git diff instead of running git |
| `--root <dir>` | The repository root (default: the current folder) |
| `--summary-file <path>` | Where to write the summary (default: `prcheck-summary.md`) |
| `--timeout-minutes <n>` | Kill timeout for the Playwright run, a whole number from 1 to 30 (default: 30) |
| `--json` | Print JSON instead of the Markdown summary |
| `--dry-run` | Build the command and summary without running tests or writing files |
| `--skip-llm` | Do not rank. The action sets this so the API key is not in the process that runs Playwright |

`check --help` also says that it reads `llm` from the config file for the optional LLM ranking; see LLM Ranking (Optional). The option rules are the same as for `run`. `--summary-file` takes a value and may be given once; a relative path is read from the current folder, as `--diff-file` is. `--skip-llm` makes no ranking call and prints no off line. The API key is read only from `PRCHECK_LLM_API_KEY`.

What happens:

1. The command reads the diff and picks the specs once, exactly as `select` does.
2. It runs the picked specs exactly as `run` does. Mode `none` and `--dry-run` start no test.
3. It builds the Markdown summary.
4. Unless `--dry-run` is set, it writes the summary file, writes `prcheck-selection.json` and `prcheck-results.json` beside it, and appends the summary to the file named by `$GITHUB_STEP_SUMMARY` when that is set and not empty.
5. It prints the summary, or with `--json` one JSON object.

### Check Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Every picked test passed, flaky tests included; or nothing needed to run; or `--dry-run` |
| 1 | A picked test failed, timed out or was interrupted |
| 2 | Usage or tool error, or a file could not be written |

The codes are those of `run`, plus exit 2 when a file cannot be written.

- A usage error prints the message on stderr, leaves stdout empty and writes nothing.
- An error before the run (a bad ref, a bad config file, Playwright not found) prints the message on stderr and leaves stdout empty. The summary file and the step summary still get an `Error` summary with that message, except with `--dry-run`.
- An `error` result after Playwright started prints the summary on stdout, and its first error also on stderr.
- A write failure still prints the summary on stdout. The error goes to stderr, for example `Cannot write missing/s.md: ENOENT`.

### Check Output

Real output of `node dist/cli.js check --diff-file tests/fixtures/diffs/modify.diff --summary-file <tmp>/s.md`, against the live SauceDemo site, exit code 0:

```markdown
<!-- qa-core-prcheck:summary -->
## PR Check: Passed

Every picked test passed: 4 tests in 2 specs.

| Total | Passed | Failed | Flaky | Skipped | Timed Out | Interrupted | Duration |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | 4 | 0 | 0 | 0 | 0 | 0 | 7.8s |

### Picked Specs
| Spec | Tests | Result | Reasons |
| --- | ---: | --- | --- |
| `demo/saucedemo/tests/cart/cart.spec.ts` | 2 | passed | demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/cart/cart.spec.ts |
| `demo/saucedemo/tests/checkout/checkout.spec.ts` | 2 | passed | demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/checkout/checkout.spec.ts |

---
_Advisory check, exit code 0. Mode subset, 2 of 4 specs picked. qa-core-prcheck 0.0.1._
```

The blocks, top to bottom, with one blank line between them:

| Block | When |
| --- | --- |
| `<!-- qa-core-prcheck:summary -->` | Always, as the first line, exactly once |
| `## PR Check: <Label>` | Always: `Passed`, `Failed`, `No Tests Needed`, `Not Run (Dry Run)` or `Error`, with `(Full Suite Run)` added after `Passed`, `Failed` or `Error` in mode `full` |
| Lead | Always: one sentence that says what happened |
| Counts table | When the run started: `Passed`, `Failed`, or `Error` after some tests ran |
| `### Why The Full Suite Was Picked` | Mode `full` |
| `### Failures` | A test failed, timed out or was interrupted: its status, title and project, `file:line` and first error line, in the order of the run result |
| `### Flaky Tests` | A test is flaky: its title and project, `file:line` and attempts |
| `### Picked Specs` | Mode `subset` or `full`: each spec with its test count, result and reasons |
| `### Errors`, `### Warnings` | When not empty. A spec the change deletes comes first in Warnings |
| `### Suggested Tests` | The selection has suggestions: each file, why and the suggested test, at most 10 rows. With more, a note before the table says how many there are |
| Truncation note | When the size cap left something out |
| Footer | Always: the exit code, the mode, the specs picked and the version |

The result of a picked spec is `failed` (a test failed, timed out or was interrupted), `passed (flaky)`, `skipped` (every test skipped), `passed`, `no tests ran`, or `not run` (a dry run, or an error before any of its tests ran).

### Suggested Tests

`select` and `check` list missing test suggestions. Fixed rules read the decisions of the rules above, locally: no network, no API key and no LLM. Suggestions are advisory: they never change a picked spec, the mode, the verdict, the heading, the lead or the exit code, and the agent never writes a test file. The same input gives the same suggestions, sorted by file, then kind in the order below, then reason.

| Kind | When | Why | Suggested Test |
| --- | --- | --- | --- |
| `unmapped-file` | Rule 11 decided an `app-source` or `test-support` file | `No rule or spec maps this file, so it falls back to the full suite.` | `Add a spec that covers the behaviour in <path>, or map it to a tag with an area in qa-core-prcheck.config.json.` |
| `unimported-support` | Rule 8 decided a `test-support` or `test-data` script that no spec imports | `No spec imports this file.` | `Add a spec that imports <path> and uses it, or remove the file if nothing needs it.` |
| `untagged-area` | Rule 9 gave `full`: no test has the tag of the first matching area | `Area "<glob>" matches this file, but no test has tag <tag>.` | `Add a test tagged <tag> that covers <path>.` |
| `unused-member` | Rule 5 decided a `test-support` file, and a member declared on one of its added lines is used by no file that imports it | `<name> was added or changed here, and no file that imports this one uses it.` | `Add a test that calls <name>.` for a method or function, `Add a test that uses <name>.` for a property |

How `unused-member` reads a file:

- Members are class methods (`name(`, with `async`, `static` or `public` before it, on a line that ends in `{` or that has `{` right after the parameter list and an optional return type, as in the one line `async open() { ... }`), `readonly` properties (`readonly name:` or `readonly name =`) and exported functions (`export function name(` or `export async function name(`), declared on the added lines of the file under `--root`.
- Skipped: the constructor, `private` and `protected` members, names that start with `_` or `#`, the words `if`, `for`, `while`, `switch`, `catch`, `return`, `function` and `super`, a line that ends in `;`, which is a statement such as a call, and a method name that the file itself binds with `import` (default, named, `as`, `* as`, `import type` and inline `type`, on one line or several), so a call such as `logStep('x', async () => {` to an imported helper is no member. The import names are read with the same scanner as the import graph, so a name in a comment or a string does not count. A call without `;` and without `{`, such as `logStep('checkout')`, is no member either.
- A member is used when `.name` (with no more name characters after it) or `name(` appears in a file that imports this one, directly or through other files, specs included, or anywhere in the file itself except the declaring line. An assignment such as `this.name = ...` is not a use, so the constructor line that sets a locator does not count.

Never suggested: a deleted file and the old path of a rename, ignored files (rule 1), full suite triggers (rule 2), files the Playwright config imports (rule 4), deleted support files (rule 6), specs (rules 3 and 7), docs (rule 10), and `test-data` or `other` files that no rule maps, because data files are often read at run time.

In the summary, `### Suggested Tests` is the last section before the truncation note and the footer, in every verdict that has a selection; an error before the selection has none. It shows at most 10 rows, a chosen limit. With more, a line before the table says `Showing the first 10 of <n> suggestions (a chosen limit). The selection JSON lists all of them.` When the size cap also leaves suggestion rows out, the line counts the rows really shown: `Showing the first <shown> of <n> suggestions (shortened to fit the summary size). The selection JSON lists all of them.`, also with 10 or fewer suggestions; with no row left, the heading and the line go too. The selection JSON (`select --json`, `prcheck-selection.json` and the `selection` key of `check --json`) and the `select` text list every suggestion. Over the size cap, suggestion rows are the first to go.

Real output of `node dist/cli.js check --diff-file tests/fixtures/diffs/add.diff --dry-run`, exit code 0:

```markdown
<!-- qa-core-prcheck:summary -->
## PR Check: No Tests Needed

No changed file affects a Playwright spec, so no tests ran.

### Suggested Tests
| File | Why | Suggested Test |
| --- | --- | --- |
| `demo/saucedemo/pages/wishlist-page.ts` | No spec imports this file. | Add a spec that imports demo/saucedemo/pages/wishlist-page.ts and uses it, or remove the file if nothing needs it. |

---
_Advisory check, exit code 0. Mode none, 0 of 4 specs picked. qa-core-prcheck 0.0.1._
```

### Suggestion Limits

- Text matching, not a parser. Not seen: getters and setters, `override` methods, generic methods (`name<T>(`), `export const name = () =>` helpers, `export default function` and fields that are not `readonly`. A method in an object literal or a `readonly` field in an interface can be taken for a member.
- A method signature split over lines with no `{` on its first line, such as `async open(` or `async open()` with the `{` on the next line, is not seen.
- A call line that ends in `{`, such as `logStep('x', async () => {`, is taken for a method when the file does not import that name, for example a helper read with `require(` or declared in the same file. `require(` and `import x = require()` are not read as imports.
- A member whose name is also a Playwright method, such as `goto`, counts as used when the file calls that Playwright method (`this.page.goto(`). Text cannot tell the two apart, so this errs toward no suggestion.
- The file texts are read from `--root`, as the import graph is, so that checkout should be the head of the diff. A saved diff used against another checkout reads other lines.
- Only the head version of a file is read, never the base version, so a spec that lost `expect(` calls is not seen.
- A file or an importer that cannot be read gives no member suggestion and no error; the import graph already warns about it.
- No LLM, and the cap of 10 rows is fixed.

### Check Files

| File | Written | How |
| --- | --- | --- |
| The summary file: `prcheck-summary.md`, or `--summary-file` | Every check except `--dry-run`, including after an error before the run | Overwritten |
| `prcheck-selection.json`, beside the summary file | When the selection finished | Overwritten, with the same JSON as `select --json` |
| `prcheck-results.json`, beside the summary file | When the run finished | Overwritten, with the same JSON as `run --json` |
| The file named by `$GITHUB_STEP_SUMMARY` | When it is set and not empty, except with `--dry-run` | Appended: the summary and one newline |

`.gitignore` lists `prcheck-*.json` and `prcheck-summary.md`. A file name in output and messages is relative to the current folder, or only the name when the file is outside it.

### Check JSON Shape

`--json` prints one object, with keys always in this order:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1` |
| `selection` | The `select --json` object |
| `result` | The `run --json` object |
| `summary` | `{ verdict, fullSuite, truncated, omitted, bytes, file, stepSummary }` |
| `exitCode` | The exit code of the check: `0`, `1` or `2`, and `2` after a write failure |
| `llm` | Only when an LLM ranking was attempted: `{ status, provider, model, reason }`. Absent otherwise |

In `summary`, `verdict` is `passed`, `failed`, `no-tests-needed`, `not-run` or `error`; `fullSuite` is `true` in mode `full`; `truncated` and `omitted` say whether the size cap left rows or items out and how many; `bytes` is the UTF-8 size of the Markdown; `file` is the summary file, or `null` with `--dry-run` or after a write failure; `stepSummary` is `true` when the summary was appended to `$GITHUB_STEP_SUMMARY`. After an error before the run, `--json` prints nothing, as without it.

In `llm`, `status` is `applied` or `skipped`, `provider` and `model` come from the config, and `reason` is `null` when applied or the skipped reason. The key is absent when the LLM is off (no `llm` object, provider `none`, or the key env var unset or empty), with `--dry-run`, when the run verdict is `error`, and when there is nothing to rank, so the JSON is then the same as without PR 8. `selection` and `result` never change.

The last two keys of the real output of `node dist/cli.js check --diff-file tests/fixtures/diffs/modify.diff --dry-run --json`. The `selection` and `result` objects before them are the `select --json` and `run --json` objects shown above:

```json
  "summary": {
    "verdict": "not-run",
    "fullSuite": false,
    "truncated": false,
    "omitted": 0,
    "bytes": 612,
    "file": null,
    "stepSummary": false
  },
  "exitCode": 0
}
```

### Check Limits

- The summary is capped at 60000 UTF-8 bytes. This is a chosen limit, meant to fit one PR comment in PR 6 with room for one more line. GitHub's limit for a comment body is not confirmed by GitHub docs: 65536 is seen only in third party reports of the API error "Body is too long (maximum is 65536 characters)", and the docs do not say whether it counts bytes, UTF-16 units or characters. A string never has fewer UTF-8 bytes than either, so the cap holds for all three. A job summary may have 1 MiB per step, from the GitHub docs page [Workflow commands for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands).
- Over the cap, rows and list items are left out from the end, in this order: Suggested Tests, Picked Specs, Warnings, Why The Full Suite Was Picked, Flaky Tests, Failures, Errors. A note says how many and where the full result is. The marker, heading, counts table, note and footer always stay, and the lead is cut last. A cap too small even for those is an error.
- A table cell or list item keeps at most 300 characters, a chosen limit; longer text ends in `...`. `run` already cuts error lines at 200.
- The step summary is appended, as the GitHub docs show with `>>` on the same page. The summary file and the JSON files are overwritten.
- The `comment` command posts this summary as the sticky PR comment; see the Comment Command and GitHub Action sections.
- A spec the change deletes gets a row first in Warnings, in every mode: ``Spec deleted, its tests no longer run: `<path>` ``. In mode `none` the lead becomes `No tests ran. This PR deletes <n> spec file(s) and changes nothing that affects a remaining spec.`; the heading stays `No Tests Needed` and the exit code stays 0. A deleted spec is a rule 7 decision with exactly the reason `Spec deleted, nothing to run: <path>`, so the old path of a renamed spec is never counted. A deleted spec that an `ignore` or `fullSuiteOn` pattern decides first gets no row. The rows count against the size cap like other Warnings rows.
- `CI` reaches Playwright (see Run Limits). Nothing in the summary depends on it except the run duration.
- Test titles, projects, error lines, reasons, warnings and paths come from the PR's own code, so they are escaped. Markdown characters get a backslash, `&`, `<` and `>` become entities, line breaks become spaces, a leading `-`, `+` or `1.` is escaped so it cannot start a list, and paths go in code spans. A URL that GitHub autolinks is the exception, below. `$` becomes `<span>$</span>` so two prices on one line cannot turn into math, as the GitHub docs page [Writing mathematical expressions](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions) shows.
- An `@` in that text becomes `&#64;` plus a zero width space, so it should not mention a user or team. GitHub's docs do not say how to stop a mention. Muhammad's live check on PR #14: `@` and `$x$` rendered as plain text in the PR comment and job summary; `#1` rendered as a link in the PR comment only (fixed in PR 7, live check pending). An `@` inside a path in a code span cannot be escaped, and whether it can mention anyone is not confirmed.
- A `#` before a digit is written `\#` plus a zero width space, and so is the `-` of `GH-` before a digit (any case), so `#1`, `GH-1` and `owner/repo#1` should not start an issue or pull request reference. The GitHub docs page [Autolinked references and URLs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls) lists those forms. The backslash alone did not stop `#1` in a PR comment; that the zero width space does is not confirmed and is on the live check list. A path in a code span is left as it is, because an entity would show as text there; whether a reference inside a code span links is not confirmed. Commit SHAs and URLs are still linked.
- Inside a URL that GitHub autolinks, characters get no backslash and no zero width space, with the few exceptions below. GitHub's [cmark-gfm](https://github.com/github/cmark-gfm/blob/master/extensions/autolink.c) takes an autolink's address from the raw Markdown, so a backslash escape stays in it: on the throwaway PR #19 (PR 7a live check, closed without merging) `https://example.com/docs\#1-intro` became the href `https://example.com/docs%5C#1-intro`. Since PR 7b a URL is written raw when cmark-gfm would autolink it, following its `url_match` and the [GFM spec](https://github.github.com/gfm/#autolinks-extension-) (extended autolinks): `http://` or `https://` in any case, no ASCII letter just before it, a letter or digit right after `://`, and no `_` in the last two parts of the domain. It runs to the next ASCII space or tab, or `$`: cmark-gfm ends an autolink only at a tab, line break or space (`cmark_isspace`), so a no-break space (U+00A0), `\v` or `\f` does not end it. Left raw inside it: `#`, `_`, `*`, `~`, `[`, `]`, `\`, `(`, `)`, `!`, `>`, `&` and every other character, except: `|` becomes `\|` so a table row keeps its cells (GFM tables remove that backslash, so in a table the address keeps the `|`; in a list item it stays), a backtick keeps its backslash (two raw backticks in two URLs would make a code span that stops the second link and leaves the rest of it as Markdown), a `\` just before a `|` or at the end of the URL becomes `\\`, `<` becomes `&lt;`, an `&` that starts something like an entity (`&lt;`, `&#64;`, `&#x40;`) becomes `&amp;`, and `$` is written as in other text and ends the URL. `@` is left raw, so `https://example.com/@user` keeps a working link; that this mentions no one is on the live check list. Those exceptions put their escaped text into the address; a URL rarely holds them raw. Anything else that looks like a URL, `www.` addresses and `ftp://` included, is escaped as plain text. That the PR 7b output gives the address `https://example.com/docs#1-intro` is on the live check list.
- The marker is an HTML comment. The GitHub docs page [Basic writing and formatting syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) says such a comment is hidden in rendered Markdown; that a job summary hides it too is not confirmed.
- Em and en dashes in the PR's own text pass through unchanged. Tags are not shown.
- Each failure shows one error line; the expected and received values are not included (see Run Limits).
- An error before the run shows the absolute `--root` as `<root>` in the summary. stderr keeps the message as it is.
- A JSON file from an earlier check in the same folder is not removed when a later check stops before the selection.

## LLM Ranking (Optional)

Off by default. When it is on, `check` sends a short description of the change to one LLM provider after the run, and the provider answers with an order and a one line note for the picked specs and the suggestions. The rules come first and the LLM is advisory:

- It can only re-order and annotate the specs the rules picked and the suggestions the rules made. It never adds, removes or runs a spec, and never changes the selection, the run, the verdict, the heading, the lead, the counts or the exit code.
- `check` calls it after the run, unless `--skip-llm` or `--dry-run` is set. `rank` calls it later, on the files `check` wrote, and does not run Playwright. `select`, `run`, `diff` and `comment` never do. A run whose verdict is `error`, and a check with no picked spec and no suggestion, make no call.
- Any failure (network, timeout, a status, size, a bad answer, input too big) gives one warning and the deterministic order, and the exit code stays what the run gave.

### LLM Config

```json
{
  "llm": { "provider": "anthropic", "model": "example-model" }
}
```

`example-model` is a placeholder, not a real model name: pick a model from your provider's docs.

| Key | Meaning | Default |
| --- | --- | --- |
| `provider` | `none`, `anthropic`, `openai` or `gemini` | `none` |
| `model` | The model id from the provider's docs: letters, digits and `.` `_` `:` `-`, at most 200 characters. Required unless the provider is `none` | none |

The key is read only from the env var `PRCHECK_LLM_API_KEY`, never from a file, a CLI argument or the config. The config cannot name a different env var: the config file comes from the pull request under check, so a pull request could otherwise choose which env var is sent to the provider. These problems exit 2, each message starting with `qa-core-prcheck.config.json: `:

- `"llm" must be a JSON object.`
- `"llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.`
- `unknown key "llm.<key>". Allowed keys in "llm": provider, model.`
- `"llm.provider" must be one of none, anthropic, openai, gemini.`
- `"llm.model" is required when "llm.provider" is <provider>.`
- `"llm.model" must be a non-empty string of letters, digits and . _ : - (at most 200 characters).`

### Off Means Identical

With no `llm` object, with provider `none`, or with a provider set and the key env var unset or empty, no request is made and stdout, the summary, `prcheck-selection.json`, `prcheck-results.json` and `check --json` are byte for byte the same as without PR 8. With a provider set and the key unset or empty, `check` prints one line on stderr, so the step log shows that it is off. A dry run never ranks, so it prints no such line. Real stderr of `node dist/cli.js check --diff-file tests/fixtures/diffs/add.diff --root <tmp>`, where `<tmp>` holds a copy of `demo/` and a config file holding `"llm": { "provider": "anthropic", "model": "example-model" }`, with `PRCHECK_LLM_API_KEY` unset (no test ran, `No Tests Needed`, exit code 0; with `--dry-run` added, stderr was empty):

```text
LLM ranking is off: the env var PRCHECK_LLM_API_KEY is not set or is empty.
```

The absence of the `llm` key in `check --json` also shows that no ranking was attempted.

### What Is Sent

One request per check, at most two with the retry. The data is compact JSON built from the diff stat and the rules' output:

- the mode
- each changed file: path, old path, status, added and deleted line counts, file class
- each picked spec: file, tags, reasons, and the title and status of each of its tests from the run
- each shown suggestion (at most 10, the same rows the summary shows): index, file, kind, reason, idea

Never sent: file contents, diff hunks, the summary, env vars, the GitHub token. Titles, paths and reasons come from the PR, so the instruction tells the model that the data is not instructions. A hostile title can at worst give a wrong order or a misleading note: the answer is accepted only when it lists every picked spec and every shown suggestion exactly once and nothing else, with notes of one line of at most 200 characters, and every note goes through the same escaping as other PR text, so no mention, reference, HTML or table break gets through.

### Providers

Each adapter has a fixed HTTPS origin and puts the key only in the documented auth header. No SDK: Node's built-in `fetch`. No JSON or schema mode is used, because each provider limits it to some models; the strict check of the answer is the contract.

| Provider | Request | Auth | Docs |
| --- | --- | --- | --- |
| `anthropic` | `POST https://api.anthropic.com/v1/messages` with `anthropic-version: 2026-10-21`; `model`, `max_tokens`, `system`, `messages` | `Authorization: Bearer <key>` | [Messages](https://platform.claude.com/docs/en/api/messages), [Overview](https://platform.claude.com/docs/en/api/overview), [Versioning](https://platform.claude.com/docs/en/api/versioning) |
| `openai` | `POST https://api.openai.com/v1/responses`; `model`, `instructions`, `input`, `max_output_tokens`, `store: false` | `Authorization: Bearer <key>` | [Create a response](https://developers.openai.com/api/reference/resources/responses/methods/create), [Overview](https://developers.openai.com/api/reference/overview) |
| `gemini` | `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`; `systemInstruction`, `contents`, `generationConfig.maxOutputTokens`, `store: false` | `x-goog-api-key: <key>` (never `?key=` in the URL) | [generateContent](https://ai.google.dev/api/generate-content), [API reference](https://ai.google.dev/api), [API keys](https://ai.google.dev/gemini-api/docs/api-key) |

Notes from those pages:

- Anthropic: the Overview lists `Authorization: Bearer` as required "unless x-api-key is set", and `anthropic-workspace-id` as "Required with an API key that isn't scoped to a workspace." There is no config key for the workspace header, so use a workspace-scoped key; how an unscoped key behaves is not confirmed. Version `2026-10-21` rejects `temperature`, `top_p` and `top_k` with a 400 (Versioning page); none of them is sent.
- OpenAI: `store` defaults to true, so `store: false` is sent.
- Gemini: the page says `store` "Configures the logging behavior for a given request"; that every key tier accepts it is not confirmed. The API reference marks the newer Interactions API as recommended; `generateContent` is still documented and is used here.

### Ranked Summary

When the answer is accepted, the Picked Specs and Suggested Tests rows follow the LLM order, Picked Specs gets an `LLM Note` column, a suggestion's note follows its suggested test after `LLM note:`, and each of the two sections starts with a line `Ranked by LLM (advisory)` that names the provider and model. When it is skipped, the summary has the deterministic order and one Warnings row, stderr gets the same line, and inside GitHub Actions without `--json` a `::warning title=qa-core-prcheck::` annotation is printed on stdout after the summary. With `--json`, the CLI does not print that annotation, because the action reads that stdout as JSON. The action's rank step reads `llm.status` from the JSON and prints the warning itself when the status is `skipped`. A status of `off` is the stderr line only: an unset key is not a warning.

Example made with a fake fetch harness (no request left the box): `runCheck` on `tests/fixtures/diffs/modify.diff` with the fake Playwright CLI and the recorded demo cart report, provider `anthropic`, the placeholder `example-model`, and a fake reply that lists the two picked specs in reverse with one note. The Picked Specs block of the real output:

```markdown
### Picked Specs

Ranked by LLM (advisory): anthropic, example-model. The rules picked these specs; the LLM only ordered them and wrote the notes.

| Spec | Tests | Result | Reasons | LLM Note |
| --- | ---: | --- | --- | --- |
| `demo/saucedemo/tests/checkout/checkout.spec.ts` | 2 | no tests ran | demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/checkout/checkout.spec.ts | Checks the cart badge after the change. |
| `demo/saucedemo/tests/cart/cart.spec.ts` | 2 | passed | demo/saucedemo/pages/cart-page.ts is imported by demo/saucedemo/tests/cart/cart.spec.ts |  |
```

The last keys of its `check --json` object:

```json
  "exitCode": 0,
  "llm": {
    "status": "applied",
    "provider": "anthropic",
    "model": "example-model",
    "reason": null
  }
}
```

The same harness with a fake 404 reply of type `not_found_error`. The Warnings row, stderr, and the annotation printed in Actions without `--json`:

```text
- LLM ranking skipped: the provider returned status 404 (not\_found\_error). The deterministic order is used.
LLM ranking skipped: the provider returned status 404 (not_found_error). The deterministic order is used.
::warning title=qa-core-prcheck::LLM ranking skipped: the provider returned status 404 (not_found_error). The deterministic order is used.
```

The 10 suggestion row cap is applied to the deterministic order first, so the LLM can never push a suggestion out of the summary. The size cap still drops rows from the end of each section, which are now the lowest ranked.

### LLM Limits

All are chosen limits:

- 60000 ms timeout per attempt (`LLM_TIMEOUT_MS`), the body read included.
- At most 2 attempts. The retry only follows a network error, a timeout, 408, 429 or a 5xx. It waits the `retry-after` seconds when given, or 2000 ms; a `retry-after` over 10 s (`LLM_RETRY_WAIT_MAX_MS`) means no retry. So the step takes at most 2 x 60 s + 10 s.
- The answer body is read as a stream and refused over 262144 bytes (`LLM_MAX_RESPONSE_BYTES`).
- The input (instruction plus data) is at most 65536 UTF-8 bytes (`LLM_MAX_INPUT_BYTES`); over it no request is made and the ranking is skipped.
- The output token cap is 4096 (`LLM_MAX_OUTPUT_TOKENS`) in each provider's field; a cut answer is skipped.
- A note is at most 200 characters (`LLM_MAX_NOTE_CHARS`) on one line.
- Error messages keep only the status and a short error type from the provider, never the key: every message is scrubbed of it.
- Answers vary from run to run, and every call costs the key owner money on their provider account.

### Workflow Wiring

The action ranks in its own step, after Playwright has exited. Call caps stay the ones in LLM Limits (at most two attempts, and the config cannot raise them). A key that is not one printable line, or is longer than 4096 characters, is not sent. The request body is scrubbed of the key before it is sent. What the GitHub docs say:

- The key goes in a repository secret, for example `PRCHECK_LLM_API_KEY` (Settings, Secrets and variables, Actions). [Using secrets in GitHub Actions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
- "The `secrets` context is not available for composite actions due to security reasons. If you want to pass a secret to a composite action, you need to do it explicitly as an input." ([Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)). Whether `env:` on the step that uses a composite action reaches its run steps is not confirmed by the docs and is on the live check list.
- The action inputs are `llm` (default `false`) and `llm-api-key` (default empty). `llm-api-key` is mapped to `PRCHECK_LLM_API_KEY` only on the rank step, and only when `llm` is `true`. The check step unsets `PRCHECK_LLM_API_KEY` before it starts Node.
- Opt in from a workflow that pins a trusted tag, not `uses: ./`. This repo's `.github/workflows/prcheck.yml` does not set `llm` and does not pass a secret, because `uses: ./` lets the pull request change the action and read a secret passed into it. Forks still receive no secrets.

```yaml
- uses: sprintsynergyio/qa-core-prcheck@<trusted-tag>
  with:
    llm: true
    llm-api-key: ${{ secrets.PRCHECK_LLM_API_KEY }}
```

- "With the exception of GITHUB_TOKEN, secrets are not passed to the runner when a workflow is triggered from a forked repository", and "Secrets are not available to workflows triggered by Dependabot events" (same secrets page). An unset secret gives an empty string, so those runs take the off path.
- `check` still removes `PRCHECK_LLM_API_KEY` from both Playwright runs. That removal does not hide a key that is already in the check process: pull request test code runs as the same user and can read the parent environment, for example `/proc/$PPID/environ` on Linux. The action therefore does not put the key in the check step at all. `rank` runs after that process has exited and does not start Playwright. A local `check` without `--skip-llm` still ranks in the same process when the key is set; that is the desktop path, not the action path. Pull requests from forks get no secrets. The removal from the Playwright env stays, as defense in depth.
- The ranking uses only the env var `PRCHECK_LLM_API_KEY`. The config file comes from the PR itself, so it cannot choose which env var is sent, and a config that sets `llm.apiKeyEnv` exits 2. A key that is not one printable line, or is longer than 4096 characters, is not sent. A provider rejection of a well-formed key follows the retry rules in LLM Limits.

## Rank Command

Applies the optional LLM ranking to a summary that `check` already wrote. It does not run Playwright, so the API key is not in a process that runs pull request tests. The action runs it after `check --skip-llm`.

```bash
npm run build
node dist/cli.js rank --diff-file changes.diff --json
node dist/cli.js rank --base origin/main --summary-file prcheck-summary.md
```

Pass the same `--base` or `--diff-file` that `check` used. `rank` reads `prcheck-summary.md`, `prcheck-selection.json` and `prcheck-results.json`. When the selection and the result are both missing, it treats the summary as an error from before the run, appends it to `$GITHUB_STEP_SUMMARY` when that is set, and exits 0. When the diff does not match the selection, it exits 2 and leaves the summary file as `check` wrote it.

| Option | Meaning |
| --- | --- |
| `--base <ref>` | Compare against the merge base of this ref and the head |
| `--head <ref>` | The head ref (default: `HEAD`) |
| `--diff-file <path>` | Read a saved unified git diff instead of running git |
| `--root <dir>` | The repository root, where the config file is read (default: the current folder) |
| `--summary-file <path>` | The summary written by `check` (default: `prcheck-summary.md`) |
| `--json` | Print one JSON object instead of the summary |

Exit code 0 means ranked, skipped, off, or nothing to rank. Exit code 2 is a usage or tool error. The command never exits 1. With `--json` the object is `{ schemaVersion, llm, summaryRewritten, stepSummary }`. `llm` is null when no ranking was attempted, `{ status: "off" }` when the provider is set and the key is empty, and `{ status: "applied" }` or `{ status: "skipped" }` otherwise. A skipped or applied ranking rewrites the summary. Off does not.

The key is read only from `PRCHECK_LLM_API_KEY`. A key that is not one printable line, or is longer than 4096 characters, is not sent. The request body is scrubbed of the key. At most two HTTP attempts are made, and the config cannot raise that cap.

## Comment Command

Posts the summary that `check` wrote as one sticky comment on the pull request, or updates the comment it posted before, so a pull request keeps one summary comment however often it is pushed. It is meant for GitHub Actions and reads the variables GitHub sets there.

```bash
npm run build
node dist/cli.js comment --summary-file prcheck-summary.md            # post or update the sticky comment
node dist/cli.js comment --summary-file prcheck-summary.md --dry-run  # say what would happen, post nothing
```

### Comment Usage

| Option | Meaning |
| --- | --- |
| `--summary-file <path>` | The summary written by `check`. Required. A relative path is read from the current folder |
| `--dry-run` | Read the comments and say what would happen, without posting or editing a comment |

Values follow their option as a separate argument, and each option may be given once.

The command reads these variables, which GitHub Actions sets ([variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)):

| Variable | Use |
| --- | --- |
| `GITHUB_TOKEN` | The token. It is sent only in the `Authorization` header to the GitHub API, and never printed |
| `GITHUB_EVENT_NAME` | Only `pull_request` posts a comment; any other event is skipped |
| `GITHUB_EVENT_PATH` | The event payload: the pull request number and the head and base repositories |
| `GITHUB_REPOSITORY` | `owner/name`. It must be the base repository of the pull request |
| `GITHUB_API_URL` | The API URL, default `https://api.github.com`. It must use https; plain http is allowed only for 127.0.0.1, ::1 and localhost, for tests |
| `PRCHECK_COMMENT_AUTHOR` | Not set by GitHub: the action sets it from its `comment-author` input. The login whose comment is updated in place; empty or unset means `github-actions[bot]` |

What happens:

1. The command reads the summary file, then checks that the token is set and that `PRCHECK_COMMENT_AUTHOR` is a login, then that the event name is set. Any event other than `pull_request` is skipped, with no API call.
2. It reads the event. A pull request whose head repository is missing or is not the base repository is a fork, and is skipped with no API call.
3. When the author is a person (a login that does not end in `[bot]`), it calls `GET /user` first and goes on only when the token's own login is that login. So a person's comment is edited only with that person's own token.
4. It lists every page of the pull request's comments, 100 per page, and looks for the sticky comment: one written by the author, with the same login and user type (`Bot` for a `[bot]` login, `User` otherwise), whose body starts with `<!-- qa-core-prcheck:summary -->`. Nobody else's comment is ever edited, even one that starts with the marker.
5. It updates the sticky comment in place, or creates one when there is none. When there are several sticky comments, the oldest (lowest id) is updated and the others are left as they are.
6. When it created a comment and GitHub names another login as its author, it prints a `Note:` line that says which `comment-author` to set, and in GitHub Actions the same text as a warning annotation. The exit code stays 0.
7. When creating or updating the comment answers 403 and the answer is not a rate limit (no rate limit header, and no API message that says rate limit), the token can read but not write comments: it prints `Skipped`, and in GitHub Actions a warning annotation, and exits 0. The summary is still in the job summary.

`PRCHECK_COMMENT_AUTHOR` must be letters, digits and single hyphens, not at either end, optionally ending in `[bot]`: the login rules on the GitHub docs page [username considerations for external authentication](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/iam-configuration-reference/username-considerations-for-external-authentication), and the `@jenkins[bot]` example on [differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps). Anything else is a usage error, exit 2. That docs page also says managed user logins hold an underscore and a short code; those are refused for now.

Real output of the command against a local fake GitHub API on 127.0.0.1 (the same kind of fake the tests in `tests/comment-cli.test.mjs` use), with a real `check` summary, recorded for PR 6a:

```text
$ qa-core-prcheck comment --summary-file prcheck-summary.md
Comment created: https://github.com/demo-owner/demo-shop/pull/7#issuecomment-101

$ qa-core-prcheck comment --summary-file prcheck-summary.md
Comment updated: https://github.com/demo-owner/demo-shop/pull/7#issuecomment-101

$ qa-core-prcheck comment --summary-file prcheck-summary.md --dry-run
Would update comment 101
```

With a second sticky comment on the pull request, a fork, a push event, and an API that answers 403 on the list (exit 2):

```text
Comment updated: https://github.com/demo-owner/demo-shop/pull/7#issuecomment-101 (1 newer duplicate left as it is)
Skipped: fork pull request, job summary only
Skipped: not a pull_request event
GitHub API GET /repos/demo-owner/demo-shop/issues/7/comments failed with status 403: Resource not accessible by integration
Run qa-core-prcheck comment --help for usage.
```

With `GITHUB_ACTIONS=true` and an API that answers 403 on the POST (exit 0), then with an API that names `other-app[bot]` as the author of the new comment (exit 0):

```text
Skipped: the token cannot write comments (status 403), job summary only
::warning title=qa-core-prcheck::The token cannot write PR comments (status 403). The summary is in the job summary. Give the workflow pull-requests: write, or set comment: false.

Comment created: https://github.com/demo-owner/demo-shop/pull/7#issuecomment-102
Note: the comment was written by other-app[bot], not github-actions[bot]. Set comment-author to other-app[bot] to keep one sticky comment.
::warning title=qa-core-prcheck::Note: the comment was written by other-app[bot], not github-actions[bot]. Set comment-author to other-app[bot] to keep one sticky comment.
```

With `PRCHECK_COMMENT_AUTHOR="bad name"`, then with `PRCHECK_COMMENT_AUTHOR="demo-reviewer"` and a `GET /user` that answers `someone-else` (exit 2 each):

```text
PRCHECK_COMMENT_AUTHOR is not a GitHub login (letters, digits and single hyphens, optionally ending in [bot]): "bad name"
Run qa-core-prcheck comment --help for usage.

PRCHECK_COMMENT_AUTHOR is demo-reviewer, but the token's account could not be confirmed as demo-reviewer (GET /user returned someone-else)
Run qa-core-prcheck comment --help for usage.
```

### Comment Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | The comment was created or updated, or the run was skipped (not a `pull_request` event, a fork, or a 403 on creating or updating the comment that is not a rate limit) |
| 2 | Usage error (including a `PRCHECK_COMMENT_AUTHOR` that is not a login), a missing variable, a file that cannot be read, an author that `GET /user` does not confirm, or any other GitHub API error |

The command never exits 1. An error goes to stderr and stdout stays empty. An API error names the method, the path without its query, the status and the API message, cut at 200 characters (a chosen limit), and ends with the number of attempts when there was more than one.

Only a 403 on the write is skipped. A 403 on reading the comments or on `GET /user`, a rate limited 403 (one with a `retry-after` header or `x-ratelimit-remaining: 0`, or whose API message says `rate limit` in any case), and a 404, 422 or 5xx after the retries stay exit 2. That a token without write access gets status 403 with "Resource not accessible by integration" is not confirmed: the [troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api) page says that message means "your token has insufficient permissions" but names no status. See Live Checks.

### Comment Limits

- The calls are the issue comment endpoints, since every pull request is an issue ([issue comments](https://docs.github.com/en/rest/issues/comments)): `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` with `per_page=100`, the documented maximum, then `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` or `POST` on the list.
- Pages are followed through the `rel="next"` URL of the `link` header ([pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)), only when it is on the same origin as the API URL, and for at most 50 pages, a chosen limit. More pages is an error.
- Every request sends `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10` (the newest version on the [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions) page; `2022-11-28` stays supported until March 10, 2028) and `User-Agent: qa-core-prcheck/<version>`.
- That a comment made with the workflow token has the login `github-actions[bot]` and the type `Bot` is not confirmed by the GitHub docs. They say the token "is a GitHub App installation access token" ([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)) and that an installation token "identifies the app as a GitHub App bot account, such as @jenkins[bot]", but name no login for it. See Live Checks.
- With an App installation token, set `comment-author` to the app's bot login. That it is `<app-slug>[bot]` with type `Bot` is not confirmed by the docs beyond the `@jenkins[bot]` example, and is not live checked.
- With a personal access token, set `comment-author` to your own login. `GET /user` must then return that login. The docs say a classic token without the `read:user` scope gets "the public user response", which holds the login ([users](https://docs.github.com/en/rest/users/users)). Whether a fine-grained token may call `GET /user` is not confirmed, and is not live checked. `GET /user` is not on the list of [endpoints available for installation tokens](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens), which is why a `[bot]` author never calls it.
- The login from `GET /user` is compared without case, and the comments are then matched on GitHub's own spelling. That GitHub logins ignore case is not confirmed by the docs.
- Each request is stopped after 30 seconds (`REQUEST_TIMEOUT_MS`, a chosen limit, above the 10 seconds after which the [troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api) page says GitHub ends a request itself). A timeout gives `GitHub API <METHOD> <path> timed out after 30000 ms`.
- A `GET` or `PATCH` is tried again after a network error, a timeout, any 5xx, a 429, or a rate limited 403, at most 2 more times (`MAX_RETRIES`, a chosen limit). Other 4xx answers are never retried. The wait is what GitHub asks for in `retry-after`, or until `x-ratelimit-reset` when `x-ratelimit-remaining` is 0, as the [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) page says. A rate limited answer that names no wait waits 60 seconds, from the same page: "Otherwise, wait for at least one minute before retrying." The same page says "If you exceed a secondary rate limit, you will receive a `403` or `429` response and an error message that indicates that you exceeded a secondary rate limit." It gives no exact message text, and such a 403 may have no rate limit header, so a 403 whose API message (from the JSON body) holds `rate limit`, in any case, is rate limited too. The primary `API rate limit exceeded` message matches as well. Anything else waits 2 seconds times the attempt number (`RETRY_BACKOFF_MS`, a chosen value).
- When GitHub asks for a wait longer than 60 seconds (`MAX_RETRY_WAIT_MS`, a chosen limit), the command does not wait: it fails at once and the message says how many seconds GitHub asked for.
- Derived from these chosen limits, not measured: one request takes at most (2 + 1) x 30 s + 2 x 60 s = 210 seconds.
- A `POST` is never retried by the client: a failed POST may still have made the comment, and the docs do not say whether a rate limited request was processed. When the POST fails in a way worth retrying, the command waits as above, lists the comments again, then updates the sticky comment if one is there now, or else sends one more POST. Two POSTs are never sent without a fresh list between them. A second failure is an error. The [issue comments](https://docs.github.com/en/rest/issues/comments) page says "Creating content too quickly using this endpoint may result in secondary rate limiting."
- The body must start with the marker and have at most 60000 UTF-8 bytes, or nothing is sent. GitHub's own comment size limit is not confirmed by GitHub docs; if the API still refuses the body (for example with 422), the command exits 2 with the status, and the job summary still has the full text.
- Duplicates are not deleted, only counted. Two runs on the same pull request at the same moment could both find no sticky comment and both create one; the next run then updates the oldest and counts the other.
- A dry run reads the comments, so it needs the token too.
- Any message that held the token would show `***` in its place; the tests check that no output holds it.

## GitHub Action

### Action Usage

`action.yml` at the repo root is a composite action ([metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)). This repo runs it on its own pull requests with `.github/workflows/prcheck.yml`:

```yaml
# Runs qa-core-prcheck on every pull request of this repo, with the action in this repo.
# The pull_request event only, so a fork's code never runs with a write token.
# Event values never go into with: or run:; the only expression in with: is a boolean.
# Linux only. Windows and macOS coverage of the CLI is the CI workflow.
name: PR Check

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: prcheck-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  prcheck:
    name: Pick, run and summarize the Playwright tests
    # ubuntu-24.04, not ubuntu-latest. Playwright 1.60.0 cannot install Chromium on the Ubuntu 26
    # image that ubuntu-latest provides (seen on 2026-11-08).
    runs-on: ubuntu-24.04
    steps:
      # Full history, so the merge base with origin/<base branch> is there. check only runs local git.
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx playwright install --with-deps chromium
      - name: Run qa-core-prcheck
        uses: ./
        with:
          # false for a fork, and for Dependabot, whose token is read-only too: they get the job summary only.
          comment: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]' }}
      - name: Upload the check files
        if: always()
        uses: actions/upload-artifact@v7
        with:
          name: prcheck
          path: |
            prcheck-summary.md
            prcheck-selection.json
            prcheck-results.json
            demo/saucedemo/test-results/
          if-no-files-found: warn
          # A chosen value.
          retention-days: 7
```

The action runs five bash steps:

1. Build the CLI when `dist/cli.js` is missing in the action folder: `npm ci` and `npm run build` there. In this repo the workflow builds first, so this step does nothing here; for another repo it is not tested yet. Playwright is then found from `root`, in that repo's own `node_modules`.
2. Run `check --base <base> --root <root> --summary-file <file> --timeout-minutes <n> --skip-llm --json`. The base is the `base-ref` input, or `origin/` plus the `GITHUB_BASE_REF` variable when the input is empty, so no branch name is passed in through `with:`. The step clears `GITHUB_STEP_SUMMARY` and unsets `PRCHECK_LLM_API_KEY`, prints the summary to the log, records the exit code, verdict and base ref, and always passes. It does not append the job summary.
3. When the check step recorded a base ref, run `rank` with the same base, root and summary file. The API key is in this step only, and only when `llm` is `true`. A skipped ranking prints a `::warning::`. The step appends the final summary to the job summary and always passes.
4. When `comment` is `true`, run `comment --summary-file <file>` with `PRCHECK_COMMENT_AUTHOR` set from `comment-author`, record its exit code, and pass.
5. Map the exit codes (see Advisory Mode). A tool error from check, rank or comment fails the step.

Every input reaches a script through `env:` and is used as a quoted shell variable, never as an expression inside `run:`, which GitHub's docs on [script injections](https://docs.github.com/en/actions/concepts/security/script-injections) warn about. Playwright runs as with `run`: always with `--forbid-only`, with `CI` passed through, and with the git capture and reporter variables removed. GitHub Actions sets `CI` to `true` ("Always set to `true`", [variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)), so in the Action the demo config's `forbidOnly` is on and it uses 2 workers.

The action tags are `v7`, the majors the [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node) and [upload-artifact](https://github.com/actions/upload-artifact) READMEs show. Their `v7` tags declare the `node24` runtime. `ci.yml` uses the same `checkout` and `setup-node` majors.

### Action Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `base-ref` | empty | The git ref to compare against. Empty means `origin/` plus the base branch from `GITHUB_BASE_REF` |
| `root` | `.` | The repository root, relative to the workspace |
| `summary-file` | `prcheck-summary.md` | Where `check` writes the summary, relative to the workspace |
| `timeout-minutes` | `30` | Kill timeout for Playwright, a whole number from 1 to 30. The pull request config cannot raise it |
| `comment` | `true` | `true` to post or update the sticky PR comment |
| `github-token` | `${{ github.token }}` | The token for the comment; needs `pull-requests: write`. With a token other than the default, also set `comment-author`. A token that cannot write comments gets a warning and the job summary only |
| `comment-author` | `github-actions[bot]` | The login whose comment is updated in place. Set it when `github-token` is an App token (the app's `[bot]` login) or a personal access token (your own login) |
| `fail-on-test-failure` | `false` | `true` to fail the step when a picked test fails |
| `llm` | `false` | `true` to allow one optional ranking call after Playwright exits. Off unless a workflow opts in |
| `llm-api-key` | empty | The API key for the rank step only. Ignored unless `llm` is `true`. Never passed to the Playwright step |

### Action Outputs

| Output | Meaning |
| --- | --- |
| `exit-code` | The exit code of `check`: `0`, `1` or `2` |
| `verdict` | The summary verdict: `passed`, `failed`, `no-tests-needed`, `not-run` or `error` |
| `llm-status` | `applied`, `skipped`, `off`, or `none` when ranking did not run or was not attempted |

### Advisory Mode

v1 is advisory: a failed test is reported, but it does not fail the job. A tool error does.

| check exit | rank exit | comment exit | `fail-on-test-failure` | The action step |
| --- | --- | --- | --- | --- |
| 0 | 0 or skipped | 0 or skipped | any | Passes |
| 1 | 0 or skipped | 0 or skipped | `false` | Passes, with a `::warning::` annotation |
| 1 | 0 or skipped | 0 or skipped | `true` | Fails, with an `::error::` annotation |
| 2 | any | any | any | Fails, with an `::error::` annotation |
| any | 2 | any | any | Fails, with an `::error::` annotation |
| any | any | 2 | any | Fails, with an `::error::` annotation |

The check and comment steps record their exit codes and always pass, so the comment is still posted for a failed run, and the last step decides. `continue-on-error` is not used: it "Prevents a job from failing when a step fails" ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)), which would hide a tool error too. The artifact step has `if: always()`, so it runs even when the action step failed. Actions jobs show on the pull request as checks with a conclusion such as `success` or `failure` ([about status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)); where the warning annotation shows is not confirmed. See Live Checks.

### Fork Pull Requests

"The `GITHUB_TOKEN` has read-only permissions in pull requests from forked repositories" ([events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)), so a fork pull request gets the job summary and the artifact, and no comment. There are two guards:

- The `comment` command skips a pull request whose head repository is missing or is not the base repository.
- The workflow passes `comment: false` when `github.event.pull_request.head.repo.full_name` is not `github.repository`.

The same page says "Workflows triggered by Dependabot pull requests are treated as though they are from a forked repository". Those come from the same repository, so the workflow guard also passes `comment: false` when `github.actor` is `dependabot[bot]`.

That `head.repo` is `null` for a deleted fork is not confirmed by the docs, which list it as required; the command treats `null` as a fork.

### Permissions

The workflow asks for `contents: read` and `pull-requests: write` only. When any permission is set, every other one is `none` ([workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)). The issue comment endpoints are listed under both "Issues" and "Pull requests" in [permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), so `pull-requests: write` is enough to list, create and update the comment.

The workflow runs on `pull_request` only. Checkout keeps no credentials (`persist-credentials: false`), because `check` only runs local git on the full history. The token is passed to the comment step through `env:`, and no step prints it.

Another repo may run the action with a read-only token, for example with `pull-requests: read`. Then listing the comments works and creating or updating one answers 403 that is not a rate limit: the comment step prints `Skipped: the token cannot write comments (status 403), job summary only` and a warning annotation, exits 0, and the job is not failed by it. The summary is still in the job summary. To post the comment, give the workflow `pull-requests: write`; to skip it, set `comment: false`. That GitHub answers 403 here is not confirmed by the docs; see Live Checks.

### Artifacts

Each run uploads one artifact named `prcheck`, kept for 7 days (a chosen value; the limit is 1 to 90): `prcheck-summary.md`, `prcheck-selection.json`, `prcheck-results.json` and `demo/saucedemo/test-results/`, where the demo config keeps traces and screenshots of failed tests. A missing file gives a warning (`if-no-files-found: warn`), and hidden files are left out by default ([upload-artifact](https://github.com/actions/upload-artifact)). There is no html report, because `run` replaces the config reporters with `--reporter=json`.

### Live Checks

These are not confirmed by GitHub docs or local tests and are checked on a real pull request:

- The workflow runs on a pull request, and a second push updates the same comment (same comment id). This also confirms the `github-actions[bot]` login and `Bot` type, and that `X-GitHub-Api-Version: 2026-03-10` is accepted.
- The job summary shows the summary and hides the marker.
- Where the advisory warning annotation shows for a failed test.
- Whether `&#64;` plus a zero width space in a test title stops a mention.
- Whether an `@` inside a path in a code span mentions anyone.
- Whether `\#1` in a test title still becomes a cross reference.
- GitHub's comment body limit and whether it counts characters or bytes.
- PR 8: whether `env:` on the step that uses this composite action reaches its run steps, and each LLM provider fact marked not confirmed in LLM Ranking (Optional).

Results of the PR 6a live checks on throwaway pull requests (Muhammad): a `test.only` in a demo spec gave `PR Check: Error` (passed). Muhammad's live check on PR #14: `@` and `$x$` rendered as plain text in the PR comment and job summary; `#1` rendered as a link in the PR comment only (fixed in PR 7, live check pending). PR 7a live check on the throwaway PR #19 (closed without merging, 2026-10-30): the comment held one link, but its href was `https://example.com/docs%5C#1-intro` (failed, fixed in PR 7b); `#1` was plain text (passed).

Still open, for the live checks on throwaway pull requests:

- A read-only token (`pull-requests: read`): the comment step prints the `Skipped` line and a warning, and the job is not failed by it.
- PR 7: the prcheck run on the PR 7 pull request shows the Suggested Tests section, and the suggestions do not fail the job.
- PR 7: a new Page Object method that no spec calls and a new Page Object that no spec imports give the `unused-member` and `unimported-support` rows.
- PR 7: a failing test title with an `@` login, `#1`, `GH-1`, `owner/repo#1` and `$x$` pings nobody, links nothing and renders no math, in the PR comment and in the job summary.
- PR 7b: a failing test title with `https://example.com/docs#1-intro` and `#1` shows one working link whose address is exactly `https://example.com/docs#1-intro`, and `#1` as plain text, in the PR comment (the job summary cannot be read through the API; check it by eye).
- PR 7b review: the same title also holding `https://example.com/@sardar-usman` shows a second working link with exactly that address, and no mention notification reaches `sardar-usman` (GitHub notifications and the PR timeline show none).
- Whether a reference inside a path in a code span links anything. No demo path holds one, so this is not checked.
- PR 8: the prcheck run on the PR 8 pull request has no LLM line (the LLM is off).
- PR 8: with the secret, a real model and the env line on a throwaway branch, the comment shows `Ranked by LLM (advisory)`, the same picked specs and the same exit code, and the log shows no key.
- PR 8: a wrong model name gives the skipped warning and the deterministic order.
- PR 8: each provider accepts the exact request body with a real model; an Anthropic key not scoped to a workspace; Gemini accepts `store: false`, and its error JSON and `Retry-After`; OpenAI honours `store: false`.

Not confirmed and not live checked: the `<app-slug>[bot]` login and `Bot` type of an App token's comments, `GET /user` with a fine-grained personal access token, and that GitHub logins ignore case.

## Roadmap

- PR 1: scaffold and demo suite (done)
- PR 2: diff reader (done)
- PR 3: test inventory and impact mapping (done)
- PR 4: test runner and result parsing (done)
- PR 5: PR summary formatter and check command (done)
- PR 6: GitHub Action and PR comment (done)
- PR 6a: review fixes: `--forbid-only` on every run, sticky comment author, API timeout and retry, read-only token, deleted spec text (done)
- PR 7: missing test suggestions and the issue reference escape (done)
- PR 7a: review fixes after PR 7 (done)
- PR 7b: raw URLs in the summary text (done)
- PR 8: optional LLM ranking, advisory and off by default (done)
- v0.1.0: release prep, npm package `@sprintsynergy/qa-core-prcheck` (done)
- PR 9: safety and cost guards (in this tree, not yet published): config size and count limits, a kill timeout capped at 30 minutes, `rank` after Playwright, and an action that keeps the API key out of the Playwright step unless a workflow sets `llm: true`. The opt-in `--forbid-only` once planned here is not a flag: PR 6a passes it on every run
- PR 10: eval fixtures and docs (not in this tree; the unit fixtures under `tests/fixtures/` stay the regression suite)

## License

MIT. See [LICENSE](LICENSE).

---

Built by [SprintSynergy](https://sprintsynergy.com) and maintained by [Muhammad Usman](https://linkedin.com/in/sdet-muhammadusman).
