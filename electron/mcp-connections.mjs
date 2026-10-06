export const MCP_CONNECTION_LEASE_MS = 90_000
export const MCP_CLIENT_ID_HEADER = 'x-qy-mcp-client-id'

export function validMcpClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/u.test(value)
}

/**
 * Stateless HTTP cannot report durable sessions. Track authenticated MCP
 * activity instead; stdio adapters keep their own lease alive with ping.
 * Client identifiers stay private and never appear in UI notifications.
 */
export function createMcpConnectionTracker({
  ttlMs = MCP_CONNECTION_LEASE_MS,
  now = () => Date.now(),
  onChange = () => {},
  maxClients = 128,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive')
  const leases = new Map()
  const revocations = new Map()
  let epoch = 0
  let timer
  let lastSeenAt = null

  const publicState = () => ({
    connected: leases.size > 0,
    connectionCount: leases.size,
    lastSeenAt,
    connectionLeaseMs: ttlMs,
  })
  const notify = () => {
    try { onChange(publicState()) } catch { /* observers cannot break requests */ }
  }
  function schedule() {
    clearTimeout(timer)
    timer = undefined
    if (!leases.size) return
    const expiresAt = Math.min(...[...leases.values()].map((lease) => lease.expiresAt))
    timer = setTimeout(expire, Math.max(1, expiresAt - now()))
    timer.unref?.()
  }
  function expire() {
    const time = now()
    let changed = false
    for (const [id, lease] of leases) {
      if (lease.expiresAt <= time) {
        leases.delete(id)
        changed = true
      }
    }
    schedule()
    if (changed) notify()
  }
  function ticket(id) {
    return { id, epoch, revocation: revocations.get(id) ?? 0 }
  }
  function touch(id, started = ticket(id)) {
    if (started.id !== id || started.epoch !== epoch
      || started.revocation !== (revocations.get(id) ?? 0)) return false
    expire()
    const time = now()
    if (!leases.has(id) && leases.size >= maxClients) {
      const oldest = [...leases].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0]?.[0]
      leases.delete(oldest)
    }
    leases.set(id, { lastSeenAt: time, expiresAt: time + ttlMs })
    lastSeenAt = time
    schedule()
    notify()
    return true
  }
  function forget(id) {
    leases.delete(id)
    revocations.set(id, (revocations.get(id) ?? 0) + 1)
    // Bound private bookkeeping as well as active leases.
    if (revocations.size > maxClients * 2) revocations.delete(revocations.keys().next().value)
    schedule()
    notify()
  }
  function clear() {
    epoch += 1
    leases.clear()
    revocations.clear()
    lastSeenAt = null
    clearTimeout(timer)
    timer = undefined
    notify()
  }
  function snapshot() {
    expire()
    return publicState()
  }
  return { ticket, touch, forget, clear, snapshot }
}
