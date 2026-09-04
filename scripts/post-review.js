'use strict'

const fs = require('fs')

const MARKER = '<!-- papyrus-lint-review -->'
const LEVEL_EMOJI = { error: '🔴', warning: '🟡', info: 'ℹ️' }

/**
 * Parses a unified diff (as returned by the GitHub API's diff media type)
 * into a map of file path -> Set of right-side (new file) line numbers that
 * are part of the diff's hunks. Only lines covered by a hunk can carry a
 * pull request review comment.
 */
function parseDiff(diff) {
  const validLines = new Map()
  let currentPath = null
  let newLine = null

  for (const rawLine of diff.split('\n')) {
    const fileMatch = rawLine.match(/^\+\+\+ b\/(.+)$/)
    if (fileMatch) {
      currentPath = fileMatch[1]
      if (!validLines.has(currentPath)) {
        validLines.set(currentPath, new Set())
      }
      newLine = null
      continue
    }
    if (rawLine.startsWith('diff --git ')) {
      currentPath = null
      newLine = null
      continue
    }
    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      newLine = parseInt(hunkMatch[1], 10)
      continue
    }
    if (currentPath === null || newLine === null) {
      continue
    }
    if (rawLine.startsWith('-')) {
      continue
    }
    if (rawLine.startsWith('+') || rawLine.startsWith(' ')) {
      validLines.get(currentPath).add(newLine)
      newLine += 1
    }
  }

  return validLines
}

module.exports = async function postReview({ github, context, core, reportPath, reviewEvent }) {
  if (!context.payload.pull_request) {
    core.info('Not running on a pull_request event; skipping review.')
    return
  }

  if (!fs.existsSync(reportPath)) {
    core.warning(`No report found at ${reportPath}; skipping review.`)
    return
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  if (report.total_diagnostics === 0) {
    core.info('No diagnostics reported; skipping review.')
    return
  }

  const { owner, repo } = context.repo
  const pull_number = context.payload.pull_request.number
  const commit_id = context.payload.pull_request.head.sha

  const diff = await github.rest.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: 'diff' },
  })
  const validLines = parseDiff(diff.data)

  const comments = []
  const outOfDiff = []

  for (const file of report.files) {
    const linesForFile = validLines.get(file.path)
    for (const diagnostic of file.diagnostics) {
      const emoji = LEVEL_EMOJI[diagnostic.level] || 'ℹ️'
      const body = `${emoji} **[${diagnostic.rule}]** ${diagnostic.message}\n\n${MARKER}`
      if (linesForFile && linesForFile.has(diagnostic.line)) {
        comments.push({ path: file.path, line: diagnostic.line, side: 'RIGHT', body })
      } else {
        outOfDiff.push({ ...diagnostic, path: file.path })
      }
    }
  }

  await deleteStaleComments({ github, owner, repo, pull_number, core })

  const level = report.success ? 'COMMENT' : 'REQUEST_CHANGES'
  const event = reviewEvent === 'AUTO' ? level : reviewEvent

  let body = `## Papyrus Lint results\n\nFound **${report.total_diagnostics}** diagnostic(s) across **${report.files_with_diagnostics}** file(s).\n`

  if (outOfDiff.length > 0) {
    body += `\n<details><summary>${outOfDiff.length} diagnostic(s) outside the changed lines</summary>\n\n`
    for (const diagnostic of outOfDiff) {
      const emoji = LEVEL_EMOJI[diagnostic.level] || 'ℹ️'
      body += `- ${emoji} \`${diagnostic.path}:${diagnostic.line}:${diagnostic.column}\` **[${diagnostic.rule}]** ${diagnostic.message}\n`
    }
    body += '\n</details>\n'
  }

  body += `\n${MARKER}`

  try {
    await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number,
      commit_id,
      event,
      body,
      comments,
    })
    core.info(`Posted review with ${comments.length} inline comment(s).`)
  } catch (error) {
    core.warning(`Failed to create review with inline comments (${error.message}); falling back to a single issue comment.`)
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull_number,
      body,
    })
  }
}

module.exports.parseDiff = parseDiff

async function deleteStaleComments({ github, owner, repo, pull_number, core }) {
  try {
    const existing = await github.paginate(github.rest.pulls.listReviewComments, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    })
    const stale = existing.filter((comment) => comment.body && comment.body.includes(MARKER))
    for (const comment of stale) {
      try {
        await github.rest.pulls.deleteReviewComment({ owner, repo, comment_id: comment.id })
      } catch (error) {
        core.warning(`Failed to delete stale review comment ${comment.id}: ${error.message}`)
      }
    }
  } catch (error) {
    core.warning(`Failed to list existing review comments: ${error.message}`)
  }
}
