# Papyrus Lint Action

A GitHub Action that downloads the standalone [`PapyrusLinterCLI`](https://github.com/Idrinth/papyrus-lint)
binary, lints your project, and — when run on a pull request — posts the
findings as inline review comments on the changed lines.

## Usage

```yaml
name: Papyrus Lint

on: [push, pull_request]

jobs:
  lint:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4

      - uses: idrinth/papyrus-lint-action@v1
        with:
          path: Data/Source.achlist
```

On a `pull_request` event, any diagnostic that lands on a changed line is
posted as an inline review comment; diagnostics outside the diff are listed
in the review's summary instead. The job fails when `PapyrusLinterCLI` exits
non-zero (i.e. when a diagnostic meets your project's `fail_on_warning`/
`fail_on_info` thresholds in `papyrus-lint.yaml`), unless `fail-on-problems`
is set to `false`.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `path` | yes | | Path to the `.achlist` (or a single `.psc` file) to lint. |
| `version` | no | `latest` | papyrus-lint release tag to download `PapyrusLinterCLI` from. |
| `config` | no | | Path to a `papyrus-lint.yaml`/`.yml` config file, passed as `--config`. |
| `script-root` | no | | Newline-separated extra script root directories, each passed as `--script-root`. |
| `github-token` | no | `${{ github.token }}` | Token used to fetch the PR diff and post the review. |
| `create-review` | no | `true` | Whether to post a pull request review on `pull_request` events. |
| `review-event` | no | `AUTO` | `AUTO` (`REQUEST_CHANGES` on failure, otherwise `COMMENT`), `COMMENT`, or `REQUEST_CHANGES`. |
| `fail-on-problems` | no | `true` | Whether to fail the step when the lint run exits non-zero. |

## Outputs

| Name | Description |
| --- | --- |
| `success` | Whether the run succeeded under the configured failure thresholds. |
| `total-diagnostics` | Total number of diagnostics reported. |
| `report-path` | Path to the JSON report written by `PapyrusLinterCLI`. |

## How review comments are kept in sync

Each run deletes review comments it previously posted (identified by a
hidden marker) before posting fresh ones, so re-running the workflow after
pushing a fix doesn't pile up stale comments.

## Supported runners

`ubuntu-latest`, `macos-latest`, and `windows-latest` are all supported —
the action picks the matching `PapyrusLinterCLI` release asset for the
runner's OS.

## License

MIT
