#!/usr/bin/env node
/**
 * Upstream contract guard for dsh-web-pin-auth.
 *
 * The plugin has no public DSH seam: it replaces the `isAuthenticated`,
 * `authorizeIndex` and `authorizeConnect` methods on Connection's `BrowserAuth`
 * instance. DSH is free to rename or move them; when it does, the plugin fails
 * safe (authentication stays required) but silently stops doing anything.
 * This guard turns that silent drift into a red CI build.
 *
 * Usage:
 *   DSH_INSTALL_DIR=<dir>/node_modules/@deepseek-ai/dsh node scripts/compat-check.mjs
 *
 * Without DSH_INSTALL_DIR it skips successfully, so a local run needs no DSH
 * installation. CI installs the pinned `DSH_VERSION` and points the variable at
 * it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const installDir = process.env.DSH_INSTALL_DIR
if (installDir === undefined || installDir === '') {
  console.log('compat: DSH_INSTALL_DIR is not set; skipping upstream contract check')
  process.exit(0)
}

// Two layouts: a nested install keeps the dependency under
// `<dsh>/node_modules/@deepseek-ai/`, while `npm install --prefix` hoists it to
// the sibling of the dsh package (`<prefix>/node_modules/@deepseek-ai/`). CI
// uses the hoisted layout; a local global install is nested.
const candidates = [
  join(installDir, 'node_modules', '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js'),
  join(installDir, '..', 'dsh-client-connection', 'lib', 'index.js'),
]
const source = candidates.find((candidate) => existsSync(candidate))
if (source === undefined) {
  console.error(
    `compat: cannot find dsh-client-connection under either layout:\n` +
      candidates.map((candidate) => `compat:   ${candidate}`).join('\n') +
      '\ncompat: DSH_INSTALL_DIR must point at the installed @deepseek-ai/dsh package directory.',
  )
  process.exit(1)
}

const text = readFileSync(source, 'utf8')
const checks = [
  ['BrowserAuth class', /\bvar BrowserAuth = class BrowserAuth\b/],
  ['BrowserAuth.isAuthenticated()', /\bisAuthenticated\(/],
  ['BrowserAuth.authorizeIndex()', /\bauthorizeIndex\(/],
  ['BrowserAuth.authorizeConnect()', /\bauthorizeConnect\(/],
  ['Connection.browserAuth field', /this\.browserAuth = browserAuth/],
  ['Connection.admit()', /\badmit\(request\)/],
]

const missing = checks.filter(([, pattern]) => !pattern.test(text)).map(([label]) => label)
if (missing.length > 0) {
  console.error(`compat: ${source} no longer matches the patched seam`)
  for (const label of missing) console.error(`compat:   missing ${label}`)
  console.error('compat: update lib/index.js for the new DSH implementation, or pin an older DSH.')
  process.exit(1)
}

console.log(
  `compat: ${source} still exposes BrowserAuth.isAuthenticated/authorizeIndex/authorizeConnect`,
)
