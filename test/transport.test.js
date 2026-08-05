import { test } from 'node:test'
import assert from 'node:assert/strict'
import { servedFromBoard } from '../src/transport.js'

test('a page served from a board connects back to that board', () => {
  assert.equal(servedFromBoard({ hostname: '192.168.0.113' }), '192.168.0.113')
  assert.equal(servedFromBoard({ hostname: 'clearcore.local' }), 'clearcore.local')
})

test('a page served from a dev host makes the operator supply the address', () => {
  // Returning a hostname here would point the sender at the laptop running the
  // dev server, and baking in a fixed IP breaks on the next DHCP lease.
  for (const hostname of ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']) {
    assert.equal(servedFromBoard({ hostname }), null, hostname)
  }
})

test('file:// and a missing location are handled', () => {
  assert.equal(servedFromBoard({ hostname: '' }), null)
  assert.equal(servedFromBoard(undefined), null)
})
