'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const postReview = require('../scripts/post-review')
const { parseDiff } = postReview

function makeCore() {
  return { info: jest.fn(), warning: jest.fn() }
}

function makeGithub({ diff, existingComments = [], createReviewImpl } = {}) {
  return {
    rest: {
      pulls: {
        get: jest.fn().mockResolvedValue({ data: diff || '' }),
        createReview: createReviewImpl || jest.fn().mockResolvedValue({}),
        listReviewComments: jest.fn(),
        deleteReviewComment: jest.fn().mockResolvedValue({}),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({}),
      },
    },
    paginate: jest.fn().mockResolvedValue(existingComments),
  }
}

function makeContext({ isPullRequest = true, number = 42, sha = 'deadbeef' } = {}) {
  return {
    repo: { owner: 'idrinth', repo: 'papyrus-lint-action' },
    payload: isPullRequest ? { pull_request: { number, head: { sha } } } : {},
  }
}

function writeReport(dir, report) {
  const reportPath = path.join(dir, 'papyrus-lint-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report))
  return reportPath
}

describe('parseDiff', () => {
  test('maps added and context lines to their new-file line numbers', () => {
    const diff = [
      'diff --git a/Scripts/Foo.psc b/Scripts/Foo.psc',
      '--- a/Scripts/Foo.psc',
      '+++ b/Scripts/Foo.psc',
      '@@ -1,3 +1,4 @@',
      ' Scriptname Foo extends Quest',
      '+Int Property Bar Auto',
      ' Event OnInit()',
      ' EndEvent',
    ].join('\n')

    const result = parseDiff(diff)

    expect(result.get('Scripts/Foo.psc')).toEqual(new Set([1, 2, 3, 4]))
  })

  test('excludes removed lines and lines outside any hunk', () => {
    const diff = [
      'diff --git a/Scripts/Foo.psc b/Scripts/Foo.psc',
      '--- a/Scripts/Foo.psc',
      '+++ b/Scripts/Foo.psc',
      '@@ -10,3 +10,2 @@',
      ' Scriptname Foo extends Quest',
      '-Int Property Bar Auto',
      ' Event OnInit()',
    ].join('\n')

    const result = parseDiff(diff)

    expect(result.get('Scripts/Foo.psc')).toEqual(new Set([10, 11]))
  })

  test('tracks multiple files independently', () => {
    const diff = [
      'diff --git a/Scripts/Foo.psc b/Scripts/Foo.psc',
      '--- a/Scripts/Foo.psc',
      '+++ b/Scripts/Foo.psc',
      '@@ -1,1 +1,1 @@',
      '+Scriptname Foo extends Quest',
      'diff --git a/Scripts/Bar.psc b/Scripts/Bar.psc',
      '--- a/Scripts/Bar.psc',
      '+++ b/Scripts/Bar.psc',
      '@@ -5,1 +5,1 @@',
      '+Scriptname Bar extends Quest',
    ].join('\n')

    const result = parseDiff(diff)

    expect(result.get('Scripts/Foo.psc')).toEqual(new Set([1]))
    expect(result.get('Scripts/Bar.psc')).toEqual(new Set([5]))
  })

  test('returns an empty map for an empty diff', () => {
    expect(parseDiff('').size).toBe(0)
  })
})

describe('postReview', () => {
  let tmpDir

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'papyrus-lint-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test('skips when not run on a pull_request event', async () => {
    const core = makeCore()
    const github = makeGithub()
    const context = makeContext({ isPullRequest: false })

    await postReview({ github, context, core, reportPath: path.join(tmpDir, 'missing.json'), reviewEvent: 'AUTO' })

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Not running on a pull_request event'))
    expect(github.rest.pulls.get).not.toHaveBeenCalled()
  })

  test('skips when the report file does not exist', async () => {
    const core = makeCore()
    const github = makeGithub()
    const context = makeContext()

    await postReview({
      github,
      context,
      core,
      reportPath: path.join(tmpDir, 'does-not-exist.json'),
      reviewEvent: 'AUTO',
    })

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('No report found'))
    expect(github.rest.pulls.get).not.toHaveBeenCalled()
  })

  test('skips when there are no diagnostics', async () => {
    const core = makeCore()
    const github = makeGithub()
    const context = makeContext()
    const reportPath = writeReport(tmpDir, { total_diagnostics: 0, files: [] })

    await postReview({ github, context, core, reportPath, reviewEvent: 'AUTO' })

    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('No diagnostics reported'))
    expect(github.rest.pulls.get).not.toHaveBeenCalled()
  })

  test('posts inline comments for in-diff lines and summarizes out-of-diff diagnostics', async () => {
    const core = makeCore()
    const diff = [
      'diff --git a/Scripts/Foo.psc b/Scripts/Foo.psc',
      '--- a/Scripts/Foo.psc',
      '+++ b/Scripts/Foo.psc',
      '@@ -1,1 +1,2 @@',
      ' Scriptname Foo extends Quest',
      '+Int Property Bar Auto',
    ].join('\n')
    const github = makeGithub({ diff })
    const context = makeContext()
    const reportPath = writeReport(tmpDir, {
      success: true,
      total_diagnostics: 2,
      files_with_diagnostics: 1,
      files: [
        {
          path: 'Scripts/Foo.psc',
          diagnostics: [
            { rule: 'naming', level: 'warning', message: 'in diff', line: 2, column: 1 },
            { rule: 'naming', level: 'info', message: 'out of diff', line: 99, column: 1 },
          ],
        },
      ],
    })

    await postReview({ github, context, core, reportPath, reviewEvent: 'AUTO' })

    expect(github.rest.pulls.createReview).toHaveBeenCalledTimes(1)
    const call = github.rest.pulls.createReview.mock.calls[0][0]
    expect(call.event).toBe('COMMENT')
    expect(call.comments).toEqual([
      expect.objectContaining({ path: 'Scripts/Foo.psc', line: 2, side: 'RIGHT' }),
    ])
    expect(call.body).toContain('out of diff')
    expect(call.body).toContain('Scripts/Foo.psc:99:1')
  })

  test('uses REQUEST_CHANGES for AUTO when the report failed its thresholds', async () => {
    const core = makeCore()
    const github = makeGithub({ diff: '' })
    const context = makeContext()
    const reportPath = writeReport(tmpDir, {
      success: false,
      total_diagnostics: 1,
      files_with_diagnostics: 1,
      files: [
        { path: 'Scripts/Foo.psc', diagnostics: [{ rule: 'r', level: 'error', message: 'm', line: 1, column: 1 }] },
      ],
    })

    await postReview({ github, context, core, reportPath, reviewEvent: 'AUTO' })

    expect(github.rest.pulls.createReview.mock.calls[0][0].event).toBe('REQUEST_CHANGES')
  })

  test('honors an explicit reviewEvent over the AUTO default', async () => {
    const core = makeCore()
    const github = makeGithub({ diff: '' })
    const context = makeContext()
    const reportPath = writeReport(tmpDir, {
      success: false,
      total_diagnostics: 1,
      files_with_diagnostics: 1,
      files: [
        { path: 'Scripts/Foo.psc', diagnostics: [{ rule: 'r', level: 'error', message: 'm', line: 1, column: 1 }] },
      ],
    })

    await postReview({ github, context, core, reportPath, reviewEvent: 'COMMENT' })

    expect(github.rest.pulls.createReview.mock.calls[0][0].event).toBe('COMMENT')
  })

  test('deletes stale marker comments before posting a new review', async () => {
    const core = makeCore()
    const github = makeGithub({
      diff: '',
      existingComments: [
        { id: 1, body: 'old finding\n\n<!-- papyrus-lint-review -->' },
        { id: 2, body: 'unrelated human comment' },
      ],
    })
    const context = makeContext()
    const reportPath = writeReport(tmpDir, {
      success: true,
      total_diagnostics: 1,
      files_with_diagnostics: 1,
      files: [
        { path: 'Scripts/Foo.psc', diagnostics: [{ rule: 'r', level: 'info', message: 'm', line: 1, column: 1 }] },
      ],
    })

    await postReview({ github, context, core, reportPath, reviewEvent: 'AUTO' })

    expect(github.rest.pulls.deleteReviewComment).toHaveBeenCalledTimes(1)
    expect(github.rest.pulls.deleteReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 1 })
    )
  })

  test('falls back to an issue comment when creating the review fails', async () => {
    const core = makeCore()
    const createReviewImpl = jest.fn().mockRejectedValue(new Error('nope'))
    const github = makeGithub({ diff: '', createReviewImpl })
    const context = makeContext()
    const reportPath = writeReport(tmpDir, {
      success: true,
      total_diagnostics: 1,
      files_with_diagnostics: 1,
      files: [
        { path: 'Scripts/Foo.psc', diagnostics: [{ rule: 'r', level: 'info', message: 'm', line: 1, column: 1 }] },
      ],
    })

    await postReview({ github, context, core, reportPath, reviewEvent: 'AUTO' })

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to create review'))
    expect(github.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })
})
