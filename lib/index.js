/**
 * dsh-web-pin-auth — replace the DSH Web launch token with either a fixed token
 * or no authentication at all.
 *
 * `dsh web` mints a fresh process token at startup, prints it as the `?token=`
 * query of the startup URL, exchanges that token for a signed browser cookie,
 * and then requires the cookie on the frontend index, every `/api` call, and
 * every WebSocket upgrade. This plugin intercepts Connection's browser-auth
 * decision points and offers two modes:
 *
 * - **open mode** (`enabled: true`, no `token` configured): any request that passes the
 *   Host/Origin fence is admitted as the owner browser Peer. Opening the plain
 *   Web UI URL is enough; nobody needs a token.
 * - **fixed-token mode** (`token: <secret>` configured, `enabled: true`): the launch token is
 *   still required in concept, but a self-chosen constant replaces the
 *   per-process value. The constant is accepted as `?token=<secret>`,
 *   `Authorization: Bearer <secret>`, or `X-DSH-Token: <secret>`; a correct
 *   query value performs the same cookie exchange as the printed startup URL,
 *   and a correct header admits `/api` calls directly. Bookmarks and scripts
 *   keep working across restarts; anonymous requests still receive 401.
 *
 * What stays intact on purpose:
 *  - Host/Origin trust fence (`isTrusted`): a request from an untrusted
 *    authority is still rejected with 403.
 *  - Connection disposal: requests after shutdown still receive 401.
 *  - Independent API operators: a valid version-2 cookie minted by `/connect`
 *    keeps its own Peer instead of being folded into the browser Peer.
 *
 * The plugin is inert unless `enabled: true` is written explicitly. In open
 * mode anyone who can reach the listener and passes the Host/Origin
 * fence gets the owner browser Peer — the same privileges as a token holder
 * (chat, tools, shell). In fixed-token mode the token is the only gate; pick a
 * long random value and treat it like a password.
 *
 * @module dsh-web-pin-auth
 */
import { timingSafeEqual } from 'node:crypto'

/** Stable Cordis plugin name. */
export const name = 'web-pin-auth'

/** Connection provides the `browserAuth` seam this plugin adjusts. */
export const inject = ['connection']

/**
 * Normalize the plugin config without a schema dependency.
 * @param config - raw plugin config from the profile patch row.
 * @returns effective options; `token` is undefined in open mode.
 */
function readOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : undefined
  return {
    // Off unless the deployment explicitly opts in: installing the bundle
    // must not change authentication on its own.
    enabled: raw.enabled === true,
    keepApiOperators: raw.keepApiOperators !== false,
    token,
  }
}

/**
 * Assign one patched method and return the undo. A plain assignment creates an
 * own property that shadows the prototype method; the undo removes that own
 * property again so unloading this plugin restores the original behaviour
 * without a process restart.
 *
 * @param target - object owning the method (`BrowserAuth` instance).
 * @param key - method name.
 * @param next - replacement function.
 * @returns the undo action restoring the previous property state.
 */
function replaceMethod(target, key, next) {
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key)
  const previous = target[key]
  target[key] = next
  return () => {
    if (hadOwn) target[key] = previous
    else delete target[key]
  }
}

/**
 * Constant-time string comparison for the configured token.
 * @param actual - value supplied by the request.
 * @param expected - value from the plugin config.
 * @returns whether both strings are byte-identical.
 */
function sameSecret(actual, expected) {
  const left = Buffer.from(actual, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Parse a node request URL defensively.
 * @param request - node IncomingMessage-shaped request.
 * @returns the parsed URL, or undefined for a malformed value.
 */
function requestUrl(request) {
  try {
    return new URL(request?.url ?? '/', 'http://dsh.invalid')
  } catch {
    return undefined
  }
}

/**
 * Read one header from either a node request (lowercase plain object) or a
 * WHATWG Headers instance.
 * @param headers - request headers collection.
 * @param name - lowercase header name.
 * @returns the header value when it is a string.
 */
function headerValue(headers, name) {
  if (headers === undefined || headers === null) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return typeof value === 'string' ? value : undefined
  }
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * Collect every token the request presents: `?token=` query values,
 * `Authorization: Bearer <token>`, and the `X-DSH-Token` convenience header.
 * Any one correct presentation is enough.
 *
 * @param request - node IncomingMessage-shaped request.
 * @returns the presented token strings, possibly empty.
 */
function presentedTokens(request) {
  const tokens = []
  const url = requestUrl(request)
  if (url !== undefined) tokens.push(...url.searchParams.getAll('token'))

  const authorization = headerValue(request?.headers, 'authorization')
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S.*)$/i.exec(authorization.trim())
    if (match !== null) tokens.push(match[1].trim())
  }

  const custom = headerValue(request?.headers, 'x-dsh-token')
  if (custom !== undefined && custom.trim().length > 0) tokens.push(custom.trim())

  return tokens
}

/**
 * Whether the request presents the configured fixed token in any accepted form.
 * @param request - node IncomingMessage-shaped request.
 * @param fixedToken - configured constant to match.
 * @returns true only for a byte-identical token.
 */
function hasValidToken(request, fixedToken) {
  return presentedTokens(request).some((token) => sameSecret(token, fixedToken))
}

/**
 * Build the request the original handshake should see: when the caller presents
 * the fixed token, the URL carries this process's launch token instead. A wrong
 * or missing token yields the request unchanged and is therefore rejected by the
 * original code with 401.
 *
 * A shallow view is returned rather than mutating the caller's request:
 * `authorizeIndex` may receive a WHATWG `Request`, whose `url` is read-only, so
 * assigning to it would throw (and surface as a 400).
 *
 * @param auth - BrowserAuth instance owning `launchToken`.
 * @param request - node IncomingMessage or WHATWG Request.
 * @param fixedToken - configured constant to match.
 * @returns the original request, or a `{ url, method, headers }` view for the
 *   handshake; those three fields are everything the original methods read.
 */
function exchangedRequest(auth, request, fixedToken) {
  if (!hasValidToken(request, fixedToken)) return request
  if (typeof auth.launchToken !== 'string') return request
  const url = requestUrl(request)
  if (url === undefined) return request
  url.searchParams.set('token', auth.launchToken)
  return {
    url: `${url.pathname}${url.search}`,
    method: request?.method,
    headers: request?.headers,
  }
}

/**
 * Fixed-token mode: keep the original handshake, only translate the configured
 * constant into the process token, and admit API requests that present the
 * constant directly (header or query). Anonymous requests still see 401.
 *
 * @param auth - BrowserAuth instance.
 * @param options - effective config.
 * @param restores - undo list filled for the plugin disposer.
 * @param originals - untouched methods captured before patching.
 */
function patchFixedToken(auth, options, restores, originals) {
  restores.push(
    replaceMethod(auth, 'isAuthenticated', (request, secure = false) => {
      try {
        if (originals.isAuthenticated.call(auth, request, secure)) return true
      } catch {
        // A malformed cookie must never fail closed into a 401 here.
      }
      return hasValidToken(request, options.token)
    }),
  )

  restores.push(
    replaceMethod(auth, 'authorizeIndex', (request, response, secure = false) => {
      // A reverse proxy may inject the token on *every* request. Once the
      // browser holds the signed cookie, serving the index directly is what
      // stops the handshake from redirecting to the same URL forever: the
      // original only redirects when a token parameter is present, and the
      // exchange would add one again on each hop.
      const url = requestUrl(request)
      const hasQueryToken = url !== undefined && url.searchParams.getAll('token').length > 0
      if (!hasQueryToken) {
        try {
          if (originals.isAuthenticated.call(auth, request, secure)) return true
        } catch {
          // Fall through to the untouched handshake.
        }
      }
      return originals.authorizeIndex.call(
        auth,
        exchangedRequest(auth, request, options.token),
        response,
        secure,
      )
    }),
  )
  if (originals.authorizeConnect !== undefined) {
    restores.push(
      replaceMethod(auth, 'authorizeConnect', (request, response, secure = false, publish) =>
        originals.authorizeConnect.call(
          auth,
          exchangedRequest(auth, request, options.token),
          response,
          secure,
          publish,
        ),
      ),
    )
  }
}

/**
 * Open mode: admit every request as the owner browser Peer.
 *
 * @param auth - BrowserAuth instance.
 * @param options - effective config.
 * @param restores - undo list filled for the plugin disposer.
 */
function patchOpenMode(auth, options, restores) {
  // 1) Browser cookie check: admit any request, except a live /connect
  //    operator, whose own Peer must keep its `interactions` declaration.
  if (typeof auth.authenticateApi === 'function') {
    restores.push(
      replaceMethod(auth, 'isAuthenticated', (request, secure = false) => {
        if (options.keepApiOperators) {
          try {
            if (auth.authenticateApi(request, secure) !== undefined) return false
          } catch {
            // A malformed cookie must never fail closed into a 401 here.
          }
        }
        return true
      }),
    )
  } else {
    restores.push(replaceMethod(auth, 'isAuthenticated', () => true))
  }

  // 2) Frontend index: serve it to everyone. A URL still carrying `?token=`
  //    (for example the printed startup URL or an old bookmark) is redirected
  //    to the clean directory URL so the token does not linger in the address
  //    bar; the token itself is neither checked nor needed.
  restores.push(
    replaceMethod(auth, 'authorizeIndex', (request, response) => {
      const method = request?.method
      if (method === 'GET' || method === 'HEAD') {
        const url = requestUrl(request)
        if (url !== undefined && url.pathname === '/' && url.searchParams.getAll('token').length > 0) {
          url.searchParams.delete('token')
          // Relative, so a prefix-stripping proxy mount (`--public-url
          // https://app.example/ui/`) keeps the browser under /ui/ instead of
          // jumping to the site root.
          const location = `./${url.search}`
          try {
            response.writeHead(303, {
              location,
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
            })
            response.end()
            return false
          } catch {
            // A response object that refuses the redirect still gets the index.
          }
        }
      }
      return true
    }),
  )

  // 3) API clients may exchange *no* token for an operator cookie: this is the
  //    same /connect handshake, with the process token filled in server-side.
  if (typeof auth.authorizeConnect === 'function') {
    const originalAuthorizeConnect = auth.authorizeConnect.bind(auth)
    restores.push(
      replaceMethod(auth, 'authorizeConnect', (request, response, secure = false, publish) => {
        try {
          const url = requestUrl(request)
          if (url !== undefined && url.searchParams.getAll('token').length === 0 && typeof auth.launchToken === 'string') {
            url.searchParams.set('token', auth.launchToken)
            request.url = `${url.pathname}${url.search}`
          }
        } catch {
          // Fall through to the untouched handshake.
        }
        return originalAuthorizeConnect(request, response, secure, publish)
      }),
    )
  }
}

/**
 * Replace the browser-session authentication methods on Connection's
 * `BrowserAuth` owner. The `connection` service is a Cordis traceable proxy,
 * but `browserAuth` is a plain class instance reached through the proxy, so
 * these assignment patches land on the live object. The undos are registered
 * as a plugin effect, so a hot unload (removing the profile row) re-enables
 * authentication without restarting `dsh web`.
 *
 * @param ctx - plugin context with `connection` injected.
 * @param options - effective {@link readOptions} values.
 */
function patchBrowserAuth(ctx, options) {
  const conn = ctx.connection
  const auth = conn?.browserAuth
  if (!auth || typeof auth.authorizeIndex !== 'function') {
    console.log('[dsh-web-pin-auth] unrecognized Connection implementation; browser authentication left unchanged.')
    return
  }

  const restores = []
  // Registered before patching so a failure halfway still restores what was
  // replaced; the disposer runs on config update and on hot unload.
  ctx.effect(() => () => {
    for (const restore of restores.reverse()) restore()
  }, 'web-pin-auth: restore browser authentication')

  const originals = {
    isAuthenticated: auth.isAuthenticated,
    authorizeIndex: auth.authorizeIndex,
    authorizeConnect: typeof auth.authorizeConnect === 'function' ? auth.authorizeConnect : undefined,
  }

  if (options.token !== undefined) {
    patchFixedToken(auth, options, restores, originals)
    console.log('[dsh-web-pin-auth] fixed token enabled (?token=, Authorization: Bearer, X-DSH-Token); anonymous access still requires it.')
    return
  }

  patchOpenMode(auth, options, restores)
  console.log('[dsh-web-pin-auth] browser token authentication is disabled; open the Web UI URL without ?token=.')
}

/**
 * Mount the browser authentication replacement.
 * @param ctx - host plugin context.
 * @param config - profile patch row config (`enabled`, `token`, `keepApiOperators`).
 */
export function apply(ctx, config) {
  const options = readOptions(config)
  if (!options.enabled) {
    console.log('[dsh-web-pin-auth] disabled by config; dsh web keeps requiring its launch token.')
    return
  }
  patchBrowserAuth(ctx, options)
}
