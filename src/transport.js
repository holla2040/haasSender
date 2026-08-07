// Three ways to reach a controller, behind one interface:
//
//   connect()            -> Promise, resolves once the link is usable
//   send(str)            -> queue a line of g-code or a $ command
//   sendRealtime(byte)   -> a single control byte, jumping the queue
//   onLine(cb)           -> cb(line) for every complete line received
//   disconnect()
//
// Nothing above this layer knows which one is in use.

import { VirtualGrbl } from './sim.js'

/**
 * Accumulates arbitrary chunks and emits complete lines.
 * grblHAL frames are not line-aligned — a single websocket frame routinely carries
 * a status report and an `ok`, and a serial read can split a line in half.
 */
class LineSplitter {
  constructor (emit) { this.emit = emit; this.buf = '' }
  push (chunk) {
    this.buf += chunk
    let at
    while ((at = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, at).replace(/\r$/, '')
      this.buf = this.buf.slice(at + 1)
      if (line) this.emit(line)
    }
  }
}

/**
 * If this page was served from a board, that board is the one to talk to.
 *
 * Returns the hostname to connect back to, or null when we are running from a dev
 * server or the filesystem and the operator has to supply the address. Never bake
 * a specific IP in: a DHCP lease changes and a second board has its own.
 */
export function servedFromBoard (loc = globalThis.location) {
  const host = loc?.hostname
  if (!host) return null                                   // file://
  if (['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host)) return null
  return host
}

// Real-time commands are single bytes, many of them above 0x7F (0x90 feed 100%,
// 0xA0 flood toggle...). They must reach the controller as raw bytes — running
// them through a UTF-8 encoder turns 0x90 into two bytes and the controller either
// ignores it or acts on garbage.
const rawByte = (b) => new Uint8Array([b])

// ------------------------------------------------------------------- websocket

/**
 * grblHAL's networking plugin, port 81.
 *
 * The `webui-v3` subprotocol is NOT optional: verified against the board, a socket
 * opened with no subprotocol (or with `arduino`) completes the handshake and then
 * passes nothing in either direction. With `webui-v3` the socket is fully
 * bidirectional, and the server sends binary frames — so we send binary too.
 */
export function websocketTransport ({ host, port = 81 }) {
  let ws = null
  let onLineCb = () => {}
  const splitter = new LineSplitter(line => {
    // The plugin's own session handshake, not grbl output.
    if (/^(currentID|activeID):/.test(line)) return
    onLineCb(line)
  })
  const decoder = new TextDecoder()

  return {
    kind: 'websocket',
    describe: () => `ws://${host}:${port}`,

    connect () {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(`ws://${host}:${port}/`, ['webui-v3'])
        ws.binaryType = 'arraybuffer'
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error(`could not reach ${host}:${port}`))
        ws.onclose = (e) => onLineCb(`[haasSender: connection closed (${e.code})]`)
        ws.onmessage = (e) => {
          splitter.push(typeof e.data === 'string' ? e.data : decoder.decode(e.data))
        }
      })
    },

    // Guard on OPEN, not just on ws being set. `link` is assigned before the
    // handshake finishes, so the 200 ms status poller can fire into a CONNECTING
    // socket — and send() throws InvalidStateError unless the socket is open.
    // The same guard covers sends racing a close.
    send (str) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(str))
    },
    sendRealtime (byte) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(rawByte(byte))
    },
    onLine (cb) { onLineCb = cb },
    disconnect () { ws?.close(); ws = null }
  }
}

// ---------------------------------------------------------------- web serial

/**
 * USB CDC. The ClearCore enumerates as 2890:8022.
 * Requires a secure context — localhost or HTTPS — and Chrome or Edge.
 */
export function serialTransport ({ baudRate = 115200 } = {}) {
  let port = null
  let writer = null
  let reader = null
  let reading = null
  let closed = false
  let onLineCb = () => {}
  const splitter = new LineSplitter(line => onLineCb(line))
  const writeFailed = (e) => { if (!closed) onLineCb(`[haasSender: serial write failed — ${e.message}]`) }

  return {
    kind: 'serial',
    describe: () => 'USB serial',
    available: () => 'serial' in navigator,

    async connect () {
      if (!('serial' in navigator)) {
        throw new Error('Web Serial needs Chrome or Edge on localhost or HTTPS')
      }
      closed = false

      // A port the operator has already granted this origin comes back from
      // getPorts() with NO dialog — so the picker is a once-per-browser
      // ceremony rather than something a student answers every morning.
      // requestPort() needs a user gesture, which is why it is the fallback
      // and not the first move.
      // ponytail: takes the first remembered port. Fine with one machine per
      // seat; add a chooser if a bench ever has two boards plugged in.
      const remembered = await navigator.serial.getPorts()
      port = remembered[0] ?? await navigator.serial.requestPort()

      await port.open({ baudRate })
      writer = port.writable.getWriter()

      const decoder = new TextDecoder()
      reader = port.readable.getReader()
      reading = (async () => {
        try {
          while (!closed) {
            const { value, done } = await reader.read()
            if (done) break
            splitter.push(decoder.decode(value, { stream: true }))
          }
        } catch (e) {
          if (!closed) onLineCb(`[haasSender: serial read failed — ${e.message}]`)
        } finally {
          reader.releaseLock()
        }
      })()
    },

    // Writes are reported, not dropped. A pulled cable rejects the write, and
    // an unhandled rejection would leave the operator with a control that
    // looks fine until the staleness watchdog notices two seconds later.
    send (str) { writer?.write(new TextEncoder().encode(str)).catch(writeFailed) },
    sendRealtime (byte) { writer?.write(rawByte(byte)).catch(writeFailed) },
    onLine (cb) { onLineCb = cb },

    async disconnect () {
      closed = true
      // cancel() first: a pending read() on a quiet port never resolves on its own,
      // so awaiting the read loop without it hangs here forever and leaves the port
      // locked — the tab then cannot reopen it without a reload.
      try { await reader?.cancel() } catch {}
      try { writer?.releaseLock() } catch {}
      await reading
      await port?.close()
      port = writer = reader = null
    }
  }
}

// ----------------------------------------------------------------- simulator

/** A virtual grblHAL in the same tab. No hardware, no network. */
export function simTransport (opts = {}) {
  let machine = null
  let onLineCb = () => {}

  return {
    kind: 'sim',
    describe: () => 'Simulator',

    async connect () {
      machine = new VirtualGrbl(opts)
      machine.onLine(line => onLineCb(line))
      machine.start()
    },

    send (str) { machine?.write(str) },
    sendRealtime (byte) { machine?.realtime(byte) },
    onLine (cb) { onLineCb = cb },
    disconnect () { machine?.stop(); machine = null },

    // Escape hatch for the trainer: let an instructor provoke a fault on demand.
    machine: () => machine
  }
}
