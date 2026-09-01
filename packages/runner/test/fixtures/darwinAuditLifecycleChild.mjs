import { openRunnerAuditLifecycle } from '../../dist/index.js'

const root = process.argv[2]
if (!root) process.exit(2)

const opened = await openRunnerAuditLifecycle({ runnerHome: root })
if (opened.status !== 'ready') process.exit(1)
await opened.audit.append({
  schemaVersion: 2,
  eventId: 'darwin-audit-child-event',
  at: '2026-09-01T00:00:00.000Z',
  kind: 'spawn-admitted',
  spawnId: 'darwin-audit-child-spawn',
  spawnKind: 'pane',
  subjectId: null,
  requestId: null,
})

if (process.send) process.send({ ready: true })
setInterval(() => undefined, 1_000)
