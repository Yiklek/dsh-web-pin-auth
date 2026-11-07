import test from 'node:test'
import assert from 'node:assert/strict'

import { name, inject, apply } from '../lib/index.js'

const FIXED = 'fixed-secret-for-tests-0123456789'

/** Build the smallest Connection/BrowserAuth double the plugin touches. */
function harness() {
  const calls = { index: [], connect: [] }
  const auth = {
    launchToken: 'process-token',
    isAuthenticated: () => false,
    authenticateApi: () => undefined,
    authorizeIndex(request) {
      calls.index.push(request.url)
      return false
    },
    authorizeConnect(request, response) {
      calls.connect.push(request.url)
      response.writeHead(302, {})
      response.end()
    },
  }
  const connection = { browserAuth: auth, browserPeer: { id: 'browser-peer' } }
  const disposers = []
  const ctx = {
    connection,
    effect: (callback) => {
      disposers.push(callback())
    },
  }
  return { auth, connection, ctx, disposers, calls }
}

/** A response double capturing status and headers, like the static fallback wrapper. */
function response() {
  const out = { status: undefined, headers: undefined, body: undefined }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(body) {
      out.body = body
    },
  }
}

test('exports a Cordis plugin shape', () => {
  assert.equal(name, 'web-pin-auth')
  assert.deepEqual(inject, ['connection'])
  assert.equal(typeof apply, 'function')
})

// ── open mode: no token configured ─────────────────────────────────────────

test('open mode admits anonymous requests but keeps /connect operators distinct', () => {
  const { auth, ctx } = harness()
  apply(ctx, { enabled: true })
  assert.equal(auth.isAuthenticated({ headers: {} }), true, 'anonymous request is admitted')
  auth.authenticateApi = () => 'operator-id'
  assert.equal(auth.isAuthenticated({ headers: {} }), false, 'v2 cookie keeps its own Peer')
})

test('open mode ignores a throwing authenticateApi', () => {
  const { auth, ctx } = harness()
  auth.authenticateApi = () => {
    throw new Error('malformed cookie')
  }
  apply(ctx, { enabled: true })
  assert.equal(auth.isAuthenticated({ headers: {} }), true)
})

test('open mode serves the index without a token', () => {
  const { auth, ctx } = harness()
  apply(ctx, { enabled: true })
  assert.equal(auth.authorizeIndex({ method: 'GET', url: '/' }, response()), true)
  assert.equal(auth.authorizeIndex({ method: 'GET', url: '/index.html' }, response()), true)
})

test('open mode redirects an old token URL to a relative clean URL', () => {
  const { auth, ctx } = harness()
  apply(ctx, { enabled: true })
  const res = response()
  assert.equal(auth.authorizeIndex({ method: 'GET', url: '/?token=stale' }, res), false)
  assert.equal(res.out.status, 303)
  assert.equal(res.out.headers.location, './')
  assert.equal(res.out.headers['cache-control'], 'no-store')

  const withParam = response()
  assert.equal(auth.authorizeIndex({ method: 'GET', url: '/?token=stale&tab=1' }, withParam), false)
  assert.equal(withParam.out.headers.location, './?tab=1', 'stays relative for prefix mounts')
})

test('open mode fills the process token into /connect server-side', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true })
  auth.authorizeConnect({ method: 'GET', url: '/connect?interactions=none' }, response())
  assert.match(calls.connect[0], /[?&]token=process-token(&|$)/)
  assert.match(calls.connect[0], /interactions=none/)
})

// ── fixed-token mode: a configured constant replaces the launch token ──────

test('fixed mode rejects anonymous requests but admits a correct token', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true, token: FIXED })

  assert.equal(auth.isAuthenticated({ headers: {} }), false, 'anonymous API request stays 401')
  assert.equal(auth.isAuthenticated({ headers: { authorization: `Bearer ${FIXED}` } }), true)
  assert.equal(auth.isAuthenticated({ headers: { 'x-dsh-token': FIXED } }), true)
  assert.equal(auth.isAuthenticated({ headers: { authorization: 'Bearer nope' } }), false)

  const res = response()
  assert.equal(auth.authorizeIndex({ method: 'GET', url: '/' }, res), false, 'original 401 path runs')
  assert.deepEqual(calls.index, ['/'], 'URL is not rewritten without a token')
})

test('fixed mode honours a valid cookie without requiring the token', () => {
  const { auth, ctx } = harness()
  auth.isAuthenticated = () => true
  apply(ctx, { enabled: true, token: FIXED })
  assert.equal(auth.isAuthenticated({ headers: {} }), true)
})

test('fixed mode exchanges a correct query token for the process token', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true, token: FIXED })
  auth.authorizeIndex({ method: 'GET', url: `/?token=${FIXED}` }, response())
  assert.equal(calls.index.at(-1), '/?token=process-token')
})

test('fixed mode accepts the token from Authorization: Bearer or X-DSH-Token', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true, token: FIXED })

  const bearer = response()
  assert.equal(
    auth.authorizeIndex({ method: 'GET', url: '/', headers: { authorization: `Bearer ${FIXED}` } }, bearer),
    false,
    'the original handshake writes the 303',
  )
  assert.equal(calls.index.at(-1), '/?token=process-token')

  auth.authorizeIndex({ method: 'GET', url: '/', headers: { 'x-dsh-token': FIXED } }, response())
  assert.equal(calls.index.at(-1), '/?token=process-token')
})

test('fixed mode never mutates a read-only Request (fetch-style) url', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true, token: FIXED })

  const headerRequest = Object.freeze({
    method: 'GET',
    url: '/',
    headers: { authorization: `Bearer ${FIXED}` },
  })
  auth.authorizeIndex(headerRequest, response())
  assert.equal(calls.index.at(-1), '/?token=process-token')
  assert.equal(headerRequest.url, '/', 'the caller request stays untouched')

  const queryRequest = Object.freeze({ method: 'GET', url: `/?token=${FIXED}`, headers: {} })
  auth.authorizeIndex(queryRequest, response())
  assert.equal(calls.index.at(-1), '/?token=process-token')
  assert.equal(queryRequest.url, `/?token=${FIXED}`)
})

test('fixed mode serves the index directly once the cookie exists (proxy headers must not loop)', () => {
  const { auth, ctx, calls } = harness()
  auth.isAuthenticated = () => true
  apply(ctx, { enabled: true, token: FIXED })

  const res = response()
  assert.equal(
    auth.authorizeIndex({ method: 'GET', url: '/', headers: { 'x-dsh-token': FIXED } }, res),
    true,
    'the index is served instead of redirecting again',
  )
  assert.deepEqual(calls.index, [], 'the token handshake is not entered')
})

test('fixed mode still cleans a bookmark token even when a cookie exists', () => {
  const { auth, ctx, calls } = harness()
  auth.isAuthenticated = () => true
  apply(ctx, { enabled: true, token: FIXED })
  const res = response()
  assert.equal(auth.authorizeIndex({ method: 'GET', url: `/?token=${FIXED}` }, res), false)
  assert.equal(calls.index.at(-1), '/?token=process-token', 'the original handshake runs to strip the token')
})

test('fixed mode leaves a wrong token alone', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true, token: FIXED })
  auth.authorizeIndex({ method: 'GET', url: '/?token=nope' }, response())
  auth.authorizeIndex({ method: 'GET', url: '/', headers: { authorization: 'Bearer nope' } }, response())
  assert.deepEqual(calls.index, ['/?token=nope', '/'])
})

test('fixed mode accepts any one correct presentation', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true, token: FIXED })
  auth.authorizeIndex(
    { method: 'GET', url: `/?token=${FIXED}&token=${FIXED}&tab=1` },
    response(),
  )
  assert.equal(calls.index.at(-1), '/?token=process-token&tab=1')
})

test('fixed mode applies the same exchange to /connect', () => {
  const { auth, ctx, calls } = harness()
  apply(ctx, { enabled: true, token: FIXED })
  auth.authorizeConnect({ method: 'GET', url: `/connect?token=${FIXED}&interactions=none` }, response())
  assert.match(calls.connect[0], /[?&]token=process-token(&|$)/)
  assert.match(calls.connect[0], /interactions=none/)

  auth.authorizeConnect(
    { method: 'GET', url: '/connect?interactions=none', headers: { authorization: `Bearer ${FIXED}` } },
    response(),
  )
  assert.match(calls.connect[1], /[?&]token=process-token(&|$)/)
})

// ── lifecycle ──────────────────────────────────────────────────────────────

test('disposing restores the original methods', () => {
  const { auth, ctx, disposers } = harness()
  const before = {
    isAuthenticated: auth.isAuthenticated,
    authorizeIndex: auth.authorizeIndex,
    authorizeConnect: auth.authorizeConnect,
  }
  apply(ctx, { enabled: true })
  assert.notEqual(auth.authorizeIndex, before.authorizeIndex)
  for (const dispose of disposers) dispose()
  assert.equal(auth.isAuthenticated, before.isAuthenticated)
  assert.equal(auth.authorizeIndex, before.authorizeIndex)
  assert.equal(auth.authorizeConnect, before.authorizeConnect)
})

test('fixed mode also restores on dispose', () => {
  const { auth, ctx, disposers } = harness()
  const beforeIndex = auth.authorizeIndex
  apply(ctx, { enabled: true, token: FIXED })
  for (const dispose of disposers) dispose()
  assert.equal(auth.authorizeIndex, beforeIndex)
})

test('disabled config leaves authentication untouched', () => {
  const { auth, ctx } = harness()
  apply(ctx, { enabled: false })
  assert.equal(auth.authorizeIndex({ method: 'GET', url: '/' }, response()), false)
})

test('the plugin is inert unless enabled is explicitly true', () => {
  for (const config of [undefined, {}, { token: FIXED }, { enabled: 'true' }]) {
    const { auth, ctx, disposers } = harness()
    const beforeIndex = auth.authorizeIndex
    apply(ctx, config)
    assert.equal(auth.authorizeIndex, beforeIndex, `config ${JSON.stringify(config)} must not patch`)
    assert.deepEqual(disposers, [], 'no lifecycle effect is registered')
  }
})
