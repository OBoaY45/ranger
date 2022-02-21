/*
 * context.issue() is used for both issues and PRs
 */
const ms = require('ms')

const { getLabelConfig, getEffectiveLabel, labelsByAction } = require('../thread/util')
const { getId } = require('../util')
const getConfig = require('../config')
const { CLOSE } = require('../constants')
const analytics = require('../analytics')

module.exports = (queue) => async (context) => {
  const ID = getId(context, { action: CLOSE })

  const thread = context.payload.pull_request || context.payload.issue

  if (thread.state === 'closed') {
    return
  }

  const config = await getConfig(context)

  const withClosableLabels = thread.labels.filter(labelsByAction(config, CLOSE))

  if (withClosableLabels.length) {
    const { label, time } = getEffectiveLabel(config, withClosableLabels)

    const jobExists = await queue.getJob(ID)
    if (!jobExists) {
      const { comment } = getLabelConfig(config, label.name, CLOSE)

      if (comment && comment.trim() !== 'false') {
        const body = comment
          .replace('$DELAY', time == null ? '' : ms(time, { long: true }))
          .replace('$LABEL', label.name)
          .replace('$AUTHOR', thread.user.login)
        context.octokit.issues.createComment(context.issue({ body }))
      }
    }

    if (time >= 0) {
      return queue
        .createJob({
          ...context.issue({ installation_id: context.payload.installation.id }),
          action: CLOSE,
        })
        .setId(ID)
        .delayUntil(Date.now() + time)
        .save()
        .then((job) => {
          analytics.track(() => ({
            userId: context.payload.installation.id,
            event: `Close job created`,
            properties: {
              ...job.data,
              id: job.id,
            },
          }))
          return job
        })
    }
  }

  // If closable labels are removed, delete job for this issue
  return queue.removeJob(ID)
}
