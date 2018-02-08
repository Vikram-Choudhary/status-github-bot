// Description:
//   Script that listens to new labels on GitHub issues
//   and assigns the issues to the bounty-awaiting-approval column on the 'Status SOB Swarm' project
//
// Dependencies:
//   github: "^13.1.0"
//   probot-config: "^0.1.0"
//   probot-slack-status: "^0.2.2"
//
// Author:
//   PombeirP

const slackHelper = require('../lib/slack')
const gitHubHelpers = require('../lib/github-helpers')
const defaultConfig = require('../lib/config')

const getConfig = require('probot-config')
const Slack = require('probot-slack-status')

let slackClient = null

module.exports = (robot) => {
  // robot.on('slack.connected', ({ slack }) => {
  Slack(robot, (slack) => {
    robot.log.trace('Connected, assigned slackClient')
    slackClient = slack
  })

  robot.on('issues.labeled', async context => {
    // Make sure we don't listen to our own messages
    if (context.isBot) { return }

    // A new issue was labeled
    await assignIssueToBountyAwaitingForApproval(context, robot, true)
  })
  robot.on('issues.unlabeled', async context => {
    // Make sure we don't listen to our own messages
    if (context.isBot) { return }

    // An issue was unlabeled
    await assignIssueToBountyAwaitingForApproval(context, robot, false)
  })
}

async function assignIssueToBountyAwaitingForApproval (context, robot, assign) {
  const { github, payload } = context
  const ownerName = payload.repository.owner.login
  const repoName = payload.repository.name
  const config = await getConfig(context, 'github-bot.yml', defaultConfig(robot, '.github/github-bot.yml'))
  const projectBoardConfig = config ? config['bounty-project-board'] : null

  if (!projectBoardConfig) {
    return
  }

  const watchedLabelName = projectBoardConfig['awaiting-approval-label-name']
  if (payload.label.name !== watchedLabelName) {
    robot.log.debug(`assignIssueToBountyAwaitingForApproval - ${payload.label.name} doesn't match watched ${watchedLabelName} label. Ignoring`)
    return
  }

  if (assign) {
    robot.log(`assignIssueToBountyAwaitingForApproval - Handling labeling of #${payload.issue.number} with ${payload.label.name} on repo ${ownerName}/${repoName}`)
  } else {
    robot.log(`assignIssueToBountyAwaitingForApproval - Handling unlabeling of #${payload.issue.number} with ${payload.label.name} on repo ${ownerName}/${repoName}`)
  }

  // Fetch org projects
  // TODO: The org project and project column info should be cached
  // in order to improve performance and reduce roundtrips
  let column = null
  const projectBoardName = projectBoardConfig.name
  const approvalColumnName = projectBoardConfig['awaiting-approval-column-name']
  try {
    const orgName = ownerName

    const ghprojectsPayload = await github.projects.getOrgProjects({
      org: orgName,
      state: 'open'
    })

    // Find 'Status SOB Swarm' project
    const project = ghprojectsPayload.data.find(p => p.name === projectBoardName)
    if (!project) {
      robot.log.error(`Couldn't find project ${projectBoardName} in ${orgName} org`)
      return
    }

    robot.log.debug(`Fetched ${project.name} project (${project.id})`)

    // Fetch bounty-awaiting-approval column ID
    try {
      const ghcolumnsPayload = await github.projects.getProjectColumns({ project_id: project.id })

      column = ghcolumnsPayload.data.find(c => c.name === approvalColumnName)
      if (!column) {
        robot.log.error(`Couldn't find ${approvalColumnName} column in project ${project.name}`)
        return
      }

      robot.log.debug(`Fetched ${column.name} column (${column.id})`)
    } catch (err) {
      robot.log.error(`Couldn't fetch the github columns for project: ${err}`, ownerName, repoName, project.id)
      return
    }
  } catch (err) {
    robot.log.error(`Couldn't fetch the github projects for repo: ${err}`, ownerName, repoName)
    return
  }

  const bountyLabelName = projectBoardConfig['bounty-label-name']
  const isOfficialBounty = !!payload.issue.labels.find(l => l.name === bountyLabelName)

  if (process.env.DRY_RUN) {
    if (assign) {
      robot.log.info(`Would have created card for issue`, column.id, payload.issue.id)
    } else {
      robot.log.info(`Would have deleted card for issue`, column.id, payload.issue.id)
    }
  } else {
    if (assign) {
      try {
        // Create project card for the issue in the bounty-awaiting-approval column
        const ghcardPayload = await github.projects.createProjectCard({
          column_id: column.id,
          content_type: 'Issue',
          content_id: payload.issue.id
        })
        const ghcard = ghcardPayload.data

        robot.log(`Created card: ${ghcard.url}`, ghcard.id)
      } catch (err) {
        robot.log.error(`Couldn't create project card for the issue: ${err}`, column.id, payload.issue.id)
      }
    } else {
      try {
        const ghcard = await gitHubHelpers.getProjectCardForIssue(github, column.id, payload.issue.url)
        if (ghcard) {
          await github.projects.deleteProjectCard({id: ghcard.id})
          robot.log(`Deleted card: ${ghcard.url}`, ghcard.id)
        }
      } catch (err) {
        robot.log.error(`Couldn't delete project card for the issue: ${err}`, column.id, payload.issue.id)
      }
    }
  }

  let message
  // Send message to Slack
  if (assign) {
    message = `Assigned issue to ${approvalColumnName} in ${projectBoardName} project\n${payload.issue.html_url}`
  } else {
    if (isOfficialBounty) {
      message = `${payload.issue.html_url} has been approved as an official bounty!`
    } else {
      message = `Unassigned issue from ${approvalColumnName} in ${projectBoardName} project\n${payload.issue.html_url}`
    }
  }

  if (message && !process.env.DRY_RUN_BOUNTY_APPROVAL) {
    // Send message to Slack
    slackHelper.sendMessage(robot, slackClient, config.slack.notification.room, message)
  }
}
