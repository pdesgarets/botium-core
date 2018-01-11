const util = require('util')
const path = require('path')
const findRoot = require('find-root')
const copydir = require('copy-dir')
const async = require('async')
const request = require('request')
const io = require('socket.io-client')

const TcpPortUtils = require('../helpers/TcpPortUtils')
const Capabilities = require('../Capabilities')
const Events = require('../Events')
const ProcessUtils = require('../helpers/ProcessUtils')
const BotiumMockMessage = require('../mocks/BotiumMockMessage')
const BotiumMockCommand = require('../mocks/BotiumMockCommand')

const botiumPackageRootDir = findRoot()

class BaseMock {
  constructor () {
    this.publishPort = null
    this.capNamePublishPort = null
    this.capNamePublishPortRange = null
    this.mockDir = null
    this.packageDir = null
    this.initCommand = null
    this.dockerComposeFile = null
  }

  SelectPublishPort (caps) {
    if (caps[this.capNamePublishPort]) {
      this.publishPort = caps[this.capNamePublishPort]
      return Promise.resolve()
    } else {
      return new Promise((resolve, reject) => {
        TcpPortUtils.GetFreePortInRange('127.0.0.1', caps[this.capNamePublishPortRange])
          .then((port) => {
            this.publishPort = port
            resolve()
          })
          .catch(reject)
      })
    }
  }

  PrepareDocker (mockDir) {
    this.mockDir = mockDir
    return new Promise((resolve, reject) => {
      copydir(path.resolve(botiumPackageRootDir, this.packageDir), this.mockDir, (err) => {
        if (err) return reject(new Error(`Error copying mock to ${this.mockDir}: ${util.inspect(err)}`))
        ProcessUtils.childCommandLineRun(this.initCommand, false, { cwd: this.mockDir })
          .then(() => resolve())
          .catch(reject)
      })
    })
  }

  GetDockerCompose () {
    return path.resolve(this.mockDir, this.dockerComposeFile)
  }

  Start (container) {
    return new Promise((resolve, reject) => {
      async.series([

        (mockupOnline) => {
          TcpPortUtils.WaitForPort('127.0.0.1', this.publishPort)
            .then(() => mockupOnline())
            .catch(mockupOnline)
        },

        (endpointOnline) => {
          this.mockUrl = `http://127.0.0.1:${this.publishPort}`
          let online = false
          async.until(
            () => online,
            (callback) => {
              var options = {
                uri: this.mockUrl,
                method: 'GET'
              }
              this.debug(`Mock - checking endpoint ${this.mockUrl} before proceed`)
              request(options, (err, response, body) => {
                if (err) {
                  setTimeout(callback, 2000)
                } else if (response && response.statusCode === 200) {
                  this.debug(`Mock - endpoint ${this.mockUrl} is online`)
                  online = true
                  callback()
                } else {
                  setTimeout(callback, 2000)
                }
              })
            },
            endpointOnline
          )
        },

        (socketStartDone) => {
          if (this.socket) {
            this.socket.disconnect()
            this.socket = null
          }

          this.socket = io.connect(this.mockUrl)
          this.socket.on(BotiumMockCommand.MOCKCMD_RECEIVEDFROMBOT, (botMsg) => {
            this.debug(`Mock - socket received from bot ${util.inspect(botMsg)}`)
            container._QueueBotSays(new BotiumMockMessage(botMsg))
            container.eventEmitter.emit(Events.MESSAGE_RECEIVEDFROMBOT, this, botMsg)
          })
          this.socket.on('error', (err) => {
            this.debug(`Mock - socket connection error! ${util.inspect(err)}`)
          })
          this.socket.on('connect', () => {
            this.debug(`Mock - socket connected ${this.mockUrl}`)
            container.eventEmitter.emit(Events.BOT_CONNECTED, this, this.socket)
            socketStartDone()
          })
        }

      ], (err) => {
        if (err) {
          return reject(new Error(`Start failed ${util.inspect(err)}`))
        }
        resolve()
      })
    })
  }

  Stop () {
    return new Promise((resolve) => {
      if (this.socket) {
        this.socket.disconnect()
        this.socket = null
        this.debug('Socket disconnected')
      }
      resolve()
    })
  }
}

module.exports = {
  Facebook: class FacebookMock extends BaseMock {
    constructor () {
      super()
      this.capNamePublishPort = Capabilities.FACEBOOK_PUBLISHPORT
      this.capNamePublishPortRange = Capabilities.FACEBOOK_PUBLISHPORT_RANGE
      this.packageDir = 'src/mocks/facebook'
      this.initCommand = 'npm install'
      this.dockerComposeFile = 'docker-compose.fbmock.yml'
      this.debug = require('debug')('botium-FacebookMock')
    }

    FillDockerEnv (composeEnv, caps, logging) {
      composeEnv.services['botium-fbmock'] = {
        build: {
          context: this.mockDir
        },
        logging: logging,
        volumes: [
          `${this.mockDir}:/usr/src/app`
        ],
        ports: [
          `${this.publishPort}:${this.publishPort}`
        ],
        environment: {
          BOTIUM_FACEBOOK_WEBHOOKPORT: caps[Capabilities.FACEBOOK_WEBHOOK_PORT],
          BOTIUM_FACEBOOK_WEBHOOKPATH: caps[Capabilities.FACEBOOK_WEBHOOK_PATH],
          BOTIUM_FACEBOOK_WEBHOOKURL: caps[Capabilities.FACEBOOK_WEBHOOK_URL],
          BOTIUM_FACEBOOK_PUBLISHPORT: this.publishPort,
          BOTIUM_FACEBOOK_SENDDELIVERY: `${caps[Capabilities.FACEBOOK_SEND_DELIVERY_CONFIRMATION]}`
        }
      }
    }
  },
  Slack: class SlackMock extends BaseMock {
    constructor () {
      super()
      this.capNamePublishPort = Capabilities.SLACK_PUBLISHPORT
      this.capNamePublishPortRange = Capabilities.SLACK_PUBLISHPORT_RANGE
      this.packageDir = 'src/mocks/slack'
      this.initCommand = 'npm install'
      this.dockerComposeFile = 'docker-compose.slackmock.yml'
      this.debug = require('debug')('botium-SlackMock')
    }

    FillDockerEnv (composeEnv, caps, logging) {
      composeEnv.services['botium-slackmock'] = {
        build: {
          context: this.mockDir
        },
        logging: logging,
        volumes: [
          `${this.mockDir}:/usr/src/app`
        ],
        ports: [
          `${this.publishPort}:${this.publishPort}`
        ],
        environment: {
          BOTIUM_SLACK_EVENTPORT: caps[Capabilities.SLACK_EVENT_PORT],
          BOTIUM_SLACK_EVENTPATH: caps[Capabilities.SLACK_EVENT_PATH],
          BOTIUM_SLACK_OAUTHPORT: caps[Capabilities.SLACK_OAUTH_PORT],
          BOTIUM_SLACK_OAUTHPATH: caps[Capabilities.SLACK_OAUTH_PATH],
          BOTIUM_SLACK_PUBLISHPORT: this.publishPort
        }
      }
    }
  },
  BotFramework: class BotFrameworkMock extends BaseMock {
    constructor () {
      super()
      this.capNamePublishPort = Capabilities.BOTFRAMEWORK_PUBLISHPORT
      this.capNamePublishPortRange = Capabilities.BOTFRAMEWORK_PUBLISHPORT_RANGE
      this.packageDir = 'src/mocks/botframework'
      this.initCommand = 'npm install'
      this.dockerComposeFile = 'docker-compose.botframeworkmock.yml'
      this.debug = require('debug')('botium-BotFrameworkMock')
    }

    FillDockerEnv (composeEnv, caps, logging) {
      composeEnv.services['botium-botframeworkmock'] = {
        build: {
          context: this.mockDir
        },
        logging: logging,
        volumes: [
          `${this.mockDir}:/usr/src/app`
        ],
        ports: [
          `${this.publishPort}:${this.publishPort}`
        ],
        environment: {
          BOTIUM_BOTFRAMEWORK_WEBHOOKPORT: caps[Capabilities.BOTFRAMEWORK_WEBHOOK_PORT],
          BOTIUM_BOTFRAMEWORK_WEBHOOKPATH: caps[Capabilities.BOTFRAMEWORK_WEBHOOK_PATH],
          BOTIUM_BOTFRAMEWORK_APP_ID: caps[Capabilities.BOTFRAMEWORK_APP_ID],
          BOTIUM_BOTFRAMEWORK_CHANNEL_ID: caps[Capabilities.BOTFRAMEWORK_CHANNEL_ID],
          BOTIUM_BOTFRAMEWORK_PUBLISHPORT: this.publishPort
        }
      }
    }
  }
}
