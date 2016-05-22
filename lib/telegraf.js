var debug = require('debug')('telegraf:core')
var fetch = require('node-fetch')
var FormData = require('form-data')
var fs = require('fs')
var http = require('http')
var https = require('https')
var ware = require('co-ware')
var memorySession = require('./memory-session')
var constants = require('./constants')

/**
 * Represents a Telegraf app.
 * @constructor
 * @param {string} token - Telegram token.
 * @param {object} options - Additional options.
 */
function Telegraf (token, options) {
  this.options = Object.assign({
    token: token,
    webHookAnswer: true,
    apiRoot: 'https://api.telegram.org'
  }, options)

  this.middleware = []
  this.polling = {
    offset: 0,
    started: false
  }
  this.context = {}
}

/**
 * Expose `Telegraf`.
 */
module.exports = Telegraf

/**
 * Telegraf prototype.
 */
var telegraf = Telegraf.prototype

/**
 * Expose `memorySession`.
 */
Telegraf.memorySession = memorySession

/**
 * Compose `middleware` returning
 * a fully valid middleware comprised
 * of all those which are passed.
 *
 * @param {GeneratorFumction[]} middleware
 * @return {GeneratorFumction}
 * @api public
 */
Telegraf.compose = function (middleware) {
  return function * (next) {
    if (!next) {
      next = noop()
    }
    var i = middleware.length
    while (i--) {
      next = middleware[i].call(this, next)
    }
    return yield * next
  }
}

/**
 * Generates `middleware` for handling provided event types.
 *
 * @param {string|string[]} eventTypes
 * @param {(GeneratorFunction|GeneratorFunction[])} fn - middleware
 * @api public
 */
Telegraf.handler = function (eventTypes) {
  if (typeof eventTypes === 'string') {
    eventTypes = [eventTypes]
  }
  var fns = [].slice.call(arguments, 1)
  return function * (next) {
    if (eventTypes.indexOf(this.eventType) !== -1 || eventTypes.indexOf(this.eventSubType) !== -1) {
      yield Telegraf.compose(fns)
    }
    yield next
  }
}

/**
 * O(1)
 *
 * @api private
 */
function * noop () {}

/**
 * Default error handler.
 *
 * @param {Error} err
 * @api private
 */
telegraf.onError = function (err) {
  var msg = err.stack || err.toString()
  console.error()
  console.error(msg.replace(/^/gm, '  '))
  console.error()
  throw err
}

/**
 * Start polling loop.
 *
 * @param {number} timeout
 * @param {number} limit
 * @return {Telegraf} self
 * @api public
 */
telegraf.startPolling = function (timeout, limit) {
  this.polling.started = true
  this.polling.timeout = timeout || 0
  this.polling.limit = limit || 100
  this.pollingLoop()
  return this
}

/**
 * Return a callback function suitable for the http[s].createServer() method to handle a request.
 * You may also use this callback function to mount your telegraf app in a Koa/Connect/Express app.
 *
 * @param {string} webHookPath - Webhook secret path
 * @return {Function}
 * @api public
 */
telegraf.webHookCallback = function (webHookPath) {
  webHookPath = webHookPath || '/'
  return (req, res, next) => {
    if (req.method !== 'POST' || req.url !== `${webHookPath}`) {
      if (next && typeof next === 'function') {
        return next()
      }
      res.statusCode = 403
      return res.end()
    }
    var body = ''
    req.on('data', (chunk) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
        var update = JSON.parse(body)
        this.handleUpdate(update, res)
          .then(() => {
            if (!res.finished) {
              res.writeHead(200)
              res.end()
            }
          })
          .catch((err) => {
            debug(err)
            res.writeHead(500)
            res.end()
          })
      } catch (error) {
        this.onError(error)
        res.writeHead(415)
        res.end()
      }
    })
  }
}

/**
 * Start WebHook.
 *
 * @param {string} webHookPath - Webhook secret path
 * @param {Object} tlsOptions - TLS options
 * @param {number} port - Port number
 * @param {string} [host] - WebHook secret path
 * @return {Telegraf} self
 * @api public
 */
telegraf.startWebHook = function (webHookPath, tlsOptions, port, host) {
  this.polling.started = true
  var callback = this.webHookCallback(webHookPath)
  if (tlsOptions) {
    this.webhookServer = https.createServer(tlsOptions, callback).listen(port, host)
  } else {
    this.webhookServer = http.createServer(callback).listen(port, host)
  }
  return this
}

/**
 * Stop WebHook/Polling.
 *
 * @return {Telegraf} self
 * @api public
 */
telegraf.stop = function () {
  this.polling.started = false
  if (this.webhookServer) {
    this.webhookServer.close()
  }
  return this
}

/**
 * Register a middleware.
 *
 * @param {GeneratorFunction} fn - middleware
 * @return {Telegraf} self
 * @api public
 */
telegraf.use = function (fn) {
  this.middleware.push(fn)
  return this
}

/**
 * Use the given middleware as handler for `eventType`.
 *
 * @param {string} eventType - Event type
 * @param {(GeneratorFunction|GeneratorFunction[])} fn - middleware
 * @return {Telegraf} self
 * @api public
 */
telegraf.on = function (eventTypes) {
  var fns = [].slice.call(arguments, 1)
  this.use(Telegraf.handler(eventTypes, Telegraf.compose(fns)))
  return this
}

// String -> RegEx magic!
var matchOperatorsRe = /[|\\{}()[\]^$+*?.]/g

/**
 * Use the given middleware as handler for text `trigger`.
 *
 * @param {(string|RegEx)} trigger - Text trigger
 * @param {(GeneratorFunction|GeneratorFunction[])} fn - middleware
 * @return {Telegraf} self
 * @api public
 */
telegraf.hears = function (trigger) {
  var regex = trigger instanceof RegExp
    ? trigger
    : new RegExp(trigger.replace(matchOperatorsRe, '\\$&'))
  var fns = [].slice.call(arguments, 1)

  var middleware = Telegraf.handler('text', function * (next) {
    var result = regex.exec(this.message.text)
    if (result) {
      this.__defineGetter__('match', function () {
        return result || []
      })
      yield Telegraf.compose(fns)
    }
    yield next
  })
  this.use(middleware)
  return this
}

/**
 * Returns basic information about the bot.
 *
 * @return {Promise}
 * @api public
 */
telegraf.getMe = function () {
  return this.sendRequest('getMe')
}

/**
 * Returns basic info about a file and prepare it for downloading.
 *
 * @param {string} fileId
 * @return {Promise}
 * @api public
 */
telegraf.getFile = function (fileId) {
  return this.sendRequest('getFile', {file_id: fileId})
}

/**
 * Returns temporary public link to file.
 *
 * @param {string} fileId
 * @return {Promise}
 * @api public
 */
telegraf.getFileLink = function (fileId) {
  return this.getFile(fileId).then((response) => `${this.options.apiRoot}/file/bot${this.options.token}/${response.file_path}`)
}

/**
 * Specifies an url to receive incoming updates via an outgoing webHook.
 *
 * @param {string} url
 * @param {Object} cert
 * @return {Promise}
 * @api public
 */
telegraf.setWebHook = function (url, cert) {
  var options = {
    url: url,
    certificate: cert
  }
  return this.sendRequest('setWebHook', options)
}

/**
 * Removes webhook. Shortcut for `Telegraf.setWebHook('')`
 *
 * @return {Promise}
 * @api public
 */
telegraf.removeWebHook = function () {
  return this.sendRequest('setWebHook', { url: '' })
}

/**
 * Sends text message.
 *
 * @param {(string|number)} chatId
 * @param {string} text
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendMessage = function (chatId, text, extra) {
  var options = {
    chat_id: chatId,
    text: text
  }
  return this.sendRequest('sendMessage', Object.assign(options, extra))
}

/**
 * Forwards message.
 *
 * @param {(string|number)} chatId
 * @param {(string|number)} fromChatId
 * @param {number} messageId
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.forwardMessage = function (chatId, fromChatId, messageId, extra) {
  var options = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId
  }
  return this.sendRequest('forwardMessage', Object.assign(options, extra))
}

/**
 * Sends chat action.
 *
 * @param {(string|number)} chatId
 * @param {string} action
 * @return {Promise}
 * @api public
 */
telegraf.sendChatAction = function (chatId, action) {
  var options = {
    chat_id: chatId,
    action: action
  }
  return this.sendRequest('sendChatAction', options)
}

/**
 * Returns profiles photos for provided user.
 *
 * @param {(string|number)} userId
 * @param {number} offset
 * @param {number} limit
 * @return {Promise}
 * @api public
 */
telegraf.getUserProfilePhotos = function (userId, offset, limit) {
  var options = {
    user_id: userId,
    offset: offset,
    limit: limit
  }
  return this.sendRequest('getUserProfilePhotos', options)
}

/**
 * Sends location.
 *
 * @param {(string|number)} chatId
 * @param {number} latitude
 * @param {number} longitude
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendLocation = function (chatId, latitude, longitude, extra) {
  var options = {
    chat_id: chatId,
    latitude: latitude,
    longitude: longitude
  }
  return this.sendRequest('sendLocation', Object.assign(options, extra))
}

/**
 * Sends venue.
 *
 * @param {(string|number)} chatId
 * @param {number} latitude
 * @param {number} longitude
 * @param {string} title
 * @param {string} address
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendVenue = function (chatId, latitude, longitude, title, address, extra) {
  var options = {
    chat_id: chatId,
    latitude: latitude,
    longitude: longitude,
    title: title,
    address: address
  }
  return this.sendRequest('sendVenue', Object.assign(options, extra))
}

/**
 * Sends contact.
 *
 * @param {(string|number)} chatId
 * @param {number} phoneNumber
 * @param {number} firstName
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendContact = function (chatId, phoneNumber, firstName, extra) {
  var options = {
    chat_id: chatId,
    phone_number: phoneNumber,
    first_name: firstName
  }
  return this.sendRequest('sendContact', Object.assign(options, extra))
}

/**
 * Use this method to send answers to an inline query.
 *
 * @param {number} inlineQueryId
 * @param {Object[]} results
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.answerInlineQuery = function (inlineQueryId, results, extra) {
  var options = {
    inline_query_id: inlineQueryId,
    results: JSON.stringify(results)
  }
  return this.sendRequest('answerInlineQuery', Object.assign(options, extra))
}

/**
 * Sends photo.
 *
 * @param {(string|number)} chatId
 * @param {(Object|string)} photo
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendPhoto = function (chatId, photo, extra) {
  var options = {
    chat_id: chatId,
    photo: photo
  }
  return this.sendRequest('sendPhoto', Object.assign(options, extra))
}

/**
 * Send document.
 *
 * @param {(string|number)} chatId
 * @param {(Object|string)} doc
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendDocument = function (chatId, doc, extra) {
  var options = {
    chat_id: chatId,
    document: doc
  }
  return this.sendRequest('sendDocument', Object.assign(options, extra))
}

/**
 * Sends audio.
 *
 * @param {(string|number)} chatId
 * @param {(Object|string)} audio
 * @return {Promise}
 * @api public
 */
telegraf.sendAudio = function (chatId, audio, extra) {
  var options = {
    chat_id: chatId,
    audio: audio
  }
  return this.sendRequest('sendAudio', Object.assign(options, extra))
}

/**
 * Sends sticker.
 *
 * @param {(string|number)} chatId
 * @param {(Object|string)} sticker
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendSticker = function (chatId, sticker, extra) {
  var options = {
    chat_id: chatId,
    sticker: sticker
  }
  return this.sendRequest('sendSticker', Object.assign(options, extra))
}

/**
 * Sends video.
 *
 * @param {(string|number)} chatId
 * @param {(Object|string)} video
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendVideo = function (chatId, video, extra) {
  var options = {
    chat_id: chatId,
    video: video
  }
  return this.sendRequest('sendVideo', Object.assign(options, extra))
}

/**
 * Sends voice.
 *
 * @param {(string|number)} chatId
 * @param {(Object|string)} voice
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.sendVoice = function (chatId, voice, extra) {
  var options = {
    chat_id: chatId,
    voice: voice
  }
  return this.sendRequest('sendVoice', Object.assign(options, extra))
}

/**
 * Use this method to kick a user from a group or a supergroup.
 *
 * @param {(string|number)} chatId
 * @param {number} userId
 * @return {Promise}
 * @api public
 */
telegraf.kickChatMember = function (chatId, userId) {
  var options = {
    chat_id: chatId,
    userId: userId
  }
  return this.sendRequest('kickChatMember', options)
}

/**
 * Use this method to unban a previously kicked user in a supergroup.
 *
 * @param {(string|number)} chatId
 * @param {number} userId
 * @return {Promise}
 * @api public
 */
telegraf.unbanChatMember = function (chatId, userId) {
  var options = {
    chat_id: chatId,
    userId: userId
  }
  return this.sendRequest('unbanChatMember', options)
}

/**
 * Use this method to send answers to callback queries.
 *
 * @param {number} callbackQueryId
 * @param {string} text
 * @param {boolean} showAlert
 * @return {Promise}
 * @api public
 */
telegraf.answerCallbackQuery = function (callbackQueryId, text, showAlert) {
  var options = {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: showAlert
  }
  return this.sendRequest('answerCallbackQuery', options)
}

/**
 * Use this method to edit text messages sent by the bot or via the bot.
 *
 * @param {(string|number)} chatId
 * @param {number} messageId
 * @param {string} text
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.editMessageText = function (chatId, messageId, text, extra) {
  var options = {
    chat_id: chatId,
    message_id: messageId,
    text: text
  }
  return this.sendRequest('editMessageText', Object.assign(options, extra))
}

/**
 * Use this method to edit captions of messages sent by the bot or via the bot.
 *
 * @param {(string|number)} chatId
 * @param {number} messageId
 * @param {string} caption
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.editMessageCaption = function (chatId, messageId, caption, extra) {
  var options = {
    chat_id: chatId,
    message_id: messageId,
    caption: caption
  }
  return this.sendRequest('editMessageCaption', Object.assign(options, extra))
}

/**
 * Use this method to edit only the reply markup of messages sent by the bot or via the bot.
 *
 * @param {(string|number)} chatId
 * @param {number} messageId
 * @param {Object} markup
 * @param {Object} extra
 * @return {Promise}
 * @api public
 */
telegraf.editMessageReplyMarkup = function (chatId, messageId, markup, extra) {
  var options = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: markup
  }
  return this.sendRequest('editMessageReplyMarkup', Object.assign(options, extra))
}

/**
 * Fetch updates from Telegram servers.
 *
 * @param {number} timeout
 * @param {number} limit
 * @param {number} offset
 * @return {Promise}
 * @api private
 */
telegraf.getUpdates = function (timeout, limit, offset) {
  return this.sendRequest(`getUpdates?offset=${offset}&limit=${limit}&timeout=${timeout}`)
}

/**
 * Send request to Telegram server
 *
 * @param {string} method - Telegram method
 * @param {Object} options - request options
 * @param {Object} [response] - http.ServerResponse
 * @return {Promise} Promise  with result
 * @api private
 */
telegraf.sendRequest = function (method, options, response) {
  options = Object.assign({}, options)
  var isFileRequest = Object.keys(options).filter((x) => options[x] && options[x].source).length > 0
  if (response && !response.finished && !isFileRequest) {
    debug('▷ webhook', method)
    options.method = method
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(options))
    return Promise.resolve()
  }
  if (!this.options.token) {
    throw new Error('Telegram Bot Token is required')
  }
  debug('▶︎ http', method)

  var payload = {
    method: 'POST',
    headers: isFileRequest ? {} : {'Content-Type': 'application/json'},
    body: isFileRequest ? this.buildFormData(options) : JSON.stringify(options)
  }

  return fetch(`${this.options.apiRoot}/bot${this.options.token}/${method}`, payload)
    .then((res) => res.json())
    .then((data) => {
      if (data.ok) {
        return data.result
      } else {
        throw new Error(`${data.error_code}: ${data.description}`)
      }
    })
}

/**
 * Build Form-Data from options
 *
 * @param {Object} options - Payload object
 * @return {Object} Form-Data
 * @api private
 */
telegraf.buildFormData = function (options) {
  if (options.reply_markup && typeof options.reply_markup !== 'string') {
    options.reply_markup = JSON.stringify(options.reply_markup)
  }
  var form = new FormData()
  Object.keys(options).forEach((key) => {
    var value = options[key]
    if (typeof value === 'undefined' || value == null) {
      return
    }
    if (typeof value === 'object') {
      var data = value.source
      if (data) {
        if (Buffer.isBuffer(data)) {
          form.append(key, data, {
            knownLength: data.length
          })
        } else if (fs.existsSync(data)) {
          form.append(key, fs.createReadStream(data), {
            knownLength: fs.statSync(data).size
          })
        } else {
          form.append(key, data)
        }
      }
    } else if (typeof value === 'boolean') {
      form.append(key, value.toString())
    } else {
      form.append(key, value)
    }
  })
  return form
}

/**
 * Polling loop
 *
 * @api private
 */
telegraf.pollingLoop = function () {
  if (!this.polling.started) {
    return
  }
  this.getUpdates(this.polling.timeout, this.polling.limit, this.polling.offset)
    .catch((err) => {
      console.error('Telegraf: network error', err)
      return new Promise((resolve) => {
        setTimeout(() => resolve([]), 1000)
      })
    })
    .then((updates) => {
      return Promise.all(updates.map((update) => this.handleUpdate(update)))
    })
    .then(() => this.pollingLoop())
    .catch((err) => {
      console.error('Telegraf: polling error', err)
      this.polling.started = false
    })
}

/**
 * Extract raw Telegram update
 *
 * @param {Object} update - raw Telegram update
 * @return {Object} normalized update
 * @api private
 */
telegraf.extractUpdate = function (update) {
  var result = {}
  constants.updateTypes.forEach((key) => {
    if (update[key]) {
      result.payload = update[key]
      result.type = key
    }
  })
  if (update.message) {
    constants.messageSubTypes.forEach((messageType) => {
      if (update.message[messageType]) {
        result.subType = messageType
      }
    })
  }
  return result
}

/**
 * Handle Telegram update
 *
 * @param {Object} rawUpdate - Telegram update object
 * @param {Object} [webHookResponse] - http.ServerResponse
 * @return {Promise}
 * @api public
 */
telegraf.handleUpdate = function (rawUpdate, webHookResponse) {
  var update = this.extractUpdate(rawUpdate)
  if (!update.type) {
    throw new Error('Undefined update type')
  }
  debug('⚡ update', update.type, update.subType || '--')
  var state = {}
  var context = Object.assign({
    telegraf: this,
    eventType: update.type,
    eventSubType: update.subType,
    state: state
  }, this.context)

  var proxy = this
  if (this.options.webHookAnswer && webHookResponse) {
    var self = this
    proxy = {
      sendRequest: function (method, options) {
        return self.sendRequest(method, options, webHookResponse)
      }
    }
  }

  var payload = update.payload
  var chatId = (payload.chat && payload.chat.id) || (payload.message && payload.message.chat && payload.message.chat.id)

  if (chatId) {
    constants.chatMethods.forEach((command) => {
      context[command.name] = this[command.target].bind(proxy, chatId)
    })
  }

  // 🐫-case
  var payloadContextName = update.type.replace(/^([A-Z])|[\s-_](\w)/g, (match, group1, group2) => {
    return group2 ? group2.toUpperCase() : group1.toLowerCase()
  })

  context.__defineGetter__(payloadContextName, function () {
    return payload
  })

  if (update.type === 'callback_query') {
    context.answerCallbackQuery = this.answerCallbackQuery.bind(proxy, payload.id)
  }

  if (update.type === 'inline_query') {
    context.answerInlineQuery = this.answerInlineQuery.bind(proxy, payload.id)
  }

  var ctx = ware()
  ctx.context = context
  ctx.use(Telegraf.compose(this.middleware))
  ctx.on('error', this.onError)
  return ctx.run().then(() => {
    this.polling.offset = rawUpdate.update_id + 1
  })
}