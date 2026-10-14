/**
 * The HTTP edge, exercised against a real `node:http` server.
 *
 * A faked `req`/`res` cannot see the failure these tests exist for: an oversized
 * body answered with a `413` instead of a destroyed socket. Only a client that
 * has to finish (or abandon) a real upload can tell "the response arrived" from
 * "the connection was reset", which is exactly the distinction `readBody`'s
 * drain-instead-of-destroy contract turns on.
 *
 *   node --test test/http-limits.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { apply } from '../lib/index.js'

const PREFIX = '/__deepseek-web-import/'

/** A web server shaped like dsh-host-webserver: duplicates throw, disposers delete by path. */
function makeRegistry() {
  const exact = new Map()
  return {
    exact,
    register(route) {
      if (exact.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      exact.set(route.path, route)
      return () => { exact.delete(route.path) }
    },
  }
}

/**
 * Mount the plugin on a fake DSH context and serve its routes over real HTTP.
 * @returns {Promise<{port: number, exact: Map<string, object>, stop: () => Promise<void>}>}
 *   the live carrier, its route table, and a stop function.
 */
async function serveRoutes() {
  const registry = makeRegistry()
  const services = {
    webServer: registry,
    credentials: {
      resolve: async () => ({ value: 'token' }),
      describe: async () => ({ configured: true, writable: true }),
      set: async () => {},
      unset: async () => {},
    },
    /* no route in this file may reach the network: a spawn here is the bug */
    subprocess: { spawn() { throw new Error('these routes must not spawn a child') } },
    workspaceRegistry: { list: () => [], get: () => undefined },
    sessionPersistence: {},
    sandboxPolicy: { workspaceRoot: '.' },
  }
  apply({
    /* the real fiber holds the disposer until unload, and nothing here unloads */
    effect(factory) {
      const dispose = factory()
      if (typeof dispose !== 'function') throw new Error('effect factory returned no disposer')
      return () => {}
    },
    get: (name) => services[name],
    logger: { warn() {} },
  })

  const server = createServer((req, res) => {
    const route = registry.exact.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    /* the real host awaits the handler, so a rejection reaches its own fallback */
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch(() => {
        try { res.writeHead(500); res.end() } catch { /* already answered */ }
      })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    exact: registry.exact,
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * POST one body over a raw socket — the client that can actually distinguish a
 * response from a reset — and resolve with the whole response text.
 * @param {number} port - the listening port.
 * @param {string} path - the request target.
 * @param {string} body - the request body.
 * @returns {Promise<string>} the raw HTTP response.
 */
function rawPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const chunks = []
    let settled = false
    const settle = (value, error) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    socket.on('connect', () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\n'
        + 'Content-Type: application/json\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`,
      )
      /* upload in pieces, like a browser: the server answers before the last one */
      for (let offset = 0; offset < body.length; offset += 64 * 1024) {
        socket.write(body.slice(offset, offset + 64 * 1024))
      }
    })
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
    socket.on('close', () => settle(Buffer.concat(chunks).toString('utf8')))
    /* a reset lands here: the caller sees a rejection instead of a 413 */
    socket.on('error', (error) => settle(null, error))
  })
}

/** One body comfortably over the host's 1 MiB request cap. */
function oversizedBody() {
  return JSON.stringify({ token: 'x'.repeat(2 * 1024 * 1024) })
}

test('an ordinary body still reaches its action', async (t) => {
  const carrier = await serveRoutes()
  t.after(carrier.stop)
  const response = await fetch(`http://127.0.0.1:${carrier.port}${PREFIX}saveToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'abc' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, normalized: true })
})

test('an oversized body is answered with 413 instead of resetting the connection', async (t) => {
  const carrier = await serveRoutes()
  t.after(carrier.stop)
  /* fetch rejects with a socket/undici error if the server destroys the request
     stream instead of draining it and answering */
  const response = await fetch(`http://127.0.0.1:${carrier.port}${PREFIX}saveToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: oversizedBody(),
  })
  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { ok: false, error: 'request body too large' })
  assert.equal(response.headers.get('connection'), 'close', 'the unread remainder is not left dangling')
})

test('the same 413 is visible on the wire, followed by a clean close', async (t) => {
  const carrier = await serveRoutes()
  t.after(carrier.stop)
  const raw = await rawPost(carrier.port, PREFIX + 'saveToken', oversizedBody())
  assert.match(raw, /^HTTP\/1\.1 413 /)
  assert.match(raw, /"error":"request body too large"/)
  assert.match(raw, /\r\nconnection: close\r\n/i)
  /* the body is complete JSON, not a truncated response cut off by the close */
  const body = raw.slice(raw.indexOf('\r\n\r\n') + 4)
  assert.deepEqual(JSON.parse(body), { ok: false, error: 'request body too large' })
})

test('a malformed JSON body is a 400 with a fixed message', async (t) => {
  const carrier = await serveRoutes()
  t.after(carrier.stop)
  const response = await fetch(`http://127.0.0.1:${carrier.port}${PREFIX}saveToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"broken',
  })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: 'invalid JSON body' })
})

test('a non-POST method is a 405 that advertises POST', async (t) => {
  const carrier = await serveRoutes()
  t.after(carrier.stop)
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const response = await fetch(`http://127.0.0.1:${carrier.port}${PREFIX}tokenStatus`, { method })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'POST', method)
    assert.deepEqual(await response.json(), { ok: false, error: 'method not allowed' }, method)
  }
})

test('an empty body is an empty argument record, not a 400', async (t) => {
  const carrier = await serveRoutes()
  t.after(carrier.stop)
  const response = await fetch(`http://127.0.0.1:${carrier.port}${PREFIX}tokenStatus`, { method: 'POST' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { configured: true, writable: true })
})
