const Queue = require('bee-queue')
const Sentry = require('@sentry/node')

const analytics = require('./src/analytics')

const threadLabeled = require('./src/thread/labeled')
const issueLabeled = require('./src/issue/labeled')
const pullLabeled = require('./src/pull/labeled')
const pullMerged = require('./src/pull/merged')
const pullSynchronized = require('./src/pull/synchronized')
const threadClosed = require('./src/thread/closed')
const commentDeleted = require('./src/comment/deleted')
const commentCreated = require('./src/comment/created')
const installationCreated = require('./src/installation/created')
const installationAdded = require('./src/installation/added')

const { CLOSE, MERGE, COMMENT } = require('./src/constants')

const verifyPaymentPlan = require('./src/verify-payment-plan')

// Probot will also send errors to Sentry DNS: https://probot.github.io/docs/configuration/
Sentry.init({ dsn: process.env.SENTRY_DSN })

module.exports = async robot => {
  robot.route('/').get('/health', (req, res) => res.send('OK'))

  const queue = new Queue('issues', {
    removeOnSuccess: true,
    removeOnFailure: true,
    activateDelayedJobs: true,
    redis: {
      db: 0,
      url: process.env.REDIS_URL
    }
  })

  queue.process(async job => {
    try {
      switch (job.data.action) {
        case COMMENT:
          return await threadLabeled.process(robot)(job)
        case MERGE:
          return await pullLabeled.process(robot)(job)
        case CLOSE:
        default:
          return await issueLabeled.process(robot)(job)
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        robot.log(error, job)
      }
      throw error
    }
  })

  queue.on('succeeded', (job, result) => {
    robot.log.debug(`Job ${job.id} succeeded with result: ${JSON.stringify(result, null, 2)}`)
  })

  queue.on('failed', (job, err) => {
    if (err.message !== 'Retry job') {
      robot.log.error(
        `Job ${job.id} with data ${JSON.stringify(job.data, null, 2)} failed with error ${
          err.message
        }`
      )
      Sentry.configureScope(scope => {
        if (job.data.owner) {
          scope.setUser({ username: job.data.owner })
        }
        Sentry.captureException(err)
      })
    }
  })

  function wrapPaymentCheck(fn) {
    return async context => {
      if (await verifyPaymentPlan(robot, context)) {
        fn(context)
      }
    }
  }

  function log(fn) {
    return function handle(context) {
      if (process.env.NODE_ENV !== 'test') {
        try {
          robot.log(context.name, context.payload.action)
          if (context.payload.installation && context.payload.installation.account) {
            robot.log(context.payload.installation.account)
          } else {
            robot.log(context.repo())
          }
        } catch (error) {
          robot.log.error(error)
        }
      }
      return fn(context)
    }
  }

  // Listeners
  robot.on(
    // All pull requests are issues in GitHub REST V3
    ['issues.labeled', 'issues.unlabeled', 'pull_request.labeled', 'pull_request.unlabeled'],
    log(wrapPaymentCheck(threadLabeled(queue)))
  )

  robot.on(['issues.labeled', 'issues.unlabeled'], log(wrapPaymentCheck(issueLabeled(queue))))

  robot.on(
    // All pull requests are issues in GitHub REST V3
    [
      'pull_request.labeled',
      'pull_request.unlabeled',
      'pull_request.synchronize',
      'pull_request_review.submitted'
      // `pull_request.edited`
    ],
    log(wrapPaymentCheck(pullLabeled(queue)))
  )
  // TODO rerun pull labeled job on `check_suite.completed`

  robot.on(
    ['issue_comment.created', 'issue_comment.edited'],
    log(wrapPaymentCheck(commentCreated()))
  )

  robot.on('pull_request.closed', log(wrapPaymentCheck(pullMerged.deleteBranch())))
  robot.on('pull_request.closed', log(wrapPaymentCheck(pullMerged.createTag())))

  robot.on(
    ['pull_request.opened', 'pull_request.synchronize'],
    log(wrapPaymentCheck(pullSynchronized()))
  )

  // Kill job when issue/pull is closed
  robot.on(['issues.closed', 'pull_request.closed'], log(threadClosed(queue)))

  robot.on('issue_comment.deleted', log(commentDeleted(queue)))

  robot.on(['installation.created'], log(installationCreated(robot)))
  robot.on(
    ['installation_repositories.added', 'installation.created'],
    log(installationAdded(robot))
  )
  // TODO 'marketplace_purchase.purchased'

  // TODO use status updates to retrigger merge jobs
  // robot.on('status', c => console.log(c.payload))

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/

  return {
    queue,
    analytics
  }
}
