// You can import your modules
const { createRobot } = require('probot')
const app = require('..')

const payload = require('./fixtures/labeled')
const wait = x => new Promise(resolve => setTimeout(resolve, x))

class MockJob {
  constructor (data, queue) {
    this.queue = queue
    this.id = Math.random().toString(36).slice(2)
    this.data = data
    this.save = jest.fn(() => {
      this.to = setTimeout(this.queue.processor, this.delay - Date.now(), this)
      return this
    })
    this.setId = jest.fn((id) => {
      delete this.queue.jobs[this.id]
      this.id = id
      this.queue.jobs[this.id] = this
      return this
    })
    this.delayUntil = jest.fn(delay => {
      this.delay = delay
      return this
    })
  }
}

class MockQueue {
  constructor (name) {
    this.name = name
    this.jobs = {}
    this.process = jest.fn(fn => {
      this.processor = fn
    })
    this.on = jest.fn()
    this.getJob = jest.fn(id => {
      return this.jobs[id]
    })
    this.createJob = jest.fn(data => {
      const job = new MockJob(data, this)
      this.jobs[job.id] = job
      return job
    })
    this.removeJob = jest.fn(id => {
      delete this.jobs[id]
      return id
    })
  }
}

const config = `
labels:
  - duplicate
  - wontfix
  - invalid
  - stale
delayTime: 1ms

comment: This issue has been marked to be closed in $CLOSE_TIME.

labelConfig:
  duplicate:
    delayTime: 5ms
    comment: $LABEL issue created! Closing in $CLOSE_TIME . . .
  stale: false
  invalid: true
  wontfix:
    delayTime: 10ms
    comment: false
`

describe('Bot', () => {
  let robot
  let github
  let queue
  beforeEach(() => {
    queue = new MockQueue()
    robot = createRobot()
    app(robot, queue)
    github = {
      issues: {
        createComment: jest.fn(),
        edit: jest.fn((_, data) => Promise.resolve({ data }))
      },
      repos: {
        getContent: jest.fn(() => ({ data: { content: Buffer.from(config).toString('base64') } }))
      }
    }
    robot.auth = () => Promise.resolve(github)
  })

  test('Will schedule a job', async () => {
    await robot.receive(payload())
    await wait(20)

    expect(github.issues.createComment).toHaveBeenCalledWith({
      number: 7,
      owner: 'mfix22',
      repo: 'test-issue-bot',
      body: 'duplicate issue created! Closing in 5 ms . . .'
    })
    const data = {
      number: 7,
      owner: 'mfix22',
      repo: 'test-issue-bot',
      installation_id: 135737
    }
    expect(queue.createJob).toHaveBeenCalledWith(data)
    expect(queue.jobs[Object.keys(queue.jobs)[0]].id).toBe('mfix22:test-issue-bot:7')
    expect(queue.jobs[Object.keys(queue.jobs)[0]].data).toEqual(data)
  })

  test('Will not act on closed issues when labeled', async () => {
    await robot.receive(payload({ state: 'closed', number: 8 }))
    await wait(20)

    expect(queue.createJob).not.toHaveBeenCalled()
    expect(queue.removeJob).not.toHaveBeenCalled()
  })

  test('Will remove a job if an issue is closed', async () => {
    await robot.receive(payload({ action: 'closed', number: 9 }))

    expect(queue.createJob).not.toHaveBeenCalled()
    expect(queue.removeJob).toHaveBeenCalledWith('mfix22:test-issue-bot:9')
  })

  test('Will delete a job all actionable labels are removed', async () => {
    await robot.receive(payload({ labels: [], number: 10 }))

    expect(queue.createJob).not.toHaveBeenCalled()
    expect(queue.removeJob).toHaveBeenCalledWith('mfix22:test-issue-bot:10')
  })

  test('Labels with `false` comment config should not send comment', async () => {
    await robot.receive(payload({ labels: ['wontfix'], number: 11 }))

    expect(github.issues.createComment).not.toHaveBeenCalled()
    expect(queue.createJob).toHaveBeenCalled()

    await wait(20)
    expect(github.issues.edit).toHaveBeenCalledTimes(1)
  })

  test('If comment was sent, comment should not be send again', async () => {
    await robot.receive(payload())
    await robot.receive(payload())

    expect(github.issues.createComment).toHaveBeenCalledTimes(1)

    await wait(20)
    expect(github.issues.edit).toHaveBeenCalledTimes(2)
  })
})
