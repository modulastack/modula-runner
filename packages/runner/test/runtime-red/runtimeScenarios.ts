import type { RuntimeRedObligation } from './obligationMatrix.js'
import { pairingFixtureBearer } from './fixtureMaterial.js'
import { requestIdFor } from './scenarioIdentity.js'
import { pairingSecrecySinks, pairingSecrecySinkMarker } from './secrecySinks.js'
import type { RuntimeOracle, RuntimeScenario, RuntimeSubject } from './scenarioTypes.js'

type Definition = {
  subject: RuntimeSubject
  fixture: string
  result: string
  require: readonly string[]
  forbid?: readonly string[]
  before?: readonly (readonly [string, string])[]
  outputIncludes?: readonly string[]
  outputExcludes?: readonly string[]
}

const definitions = new Map<string, Definition>()
const exactEventCounts: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'G1-L34': { 'process.start.call': 1 },
  'G1-W06': { 'worktree.register.call': 1 },
  'G1-W08': { 'process.start.call': 0 },
  'G1-W09': { 'process.start.call': 2, 'worktree.prepare:max-active:1': 1 },
  'G1-C01': { 'process.start.call': 1, 'channel.open:runner-id': 1 },
  'G1-C05': { 'process.start.call': 0 },
  'G1-C06': { 'process.start.call': 1 },
  'G1-C15': { 'process.start.call': 0 },
  'G1-R01': { 'process.start.call': 1 },
  'G1-R02': { 'process.start.call': 1 },
  'G1-R03': { 'process.start.call': 1 },
  'G1-R04': { 'process.start.call': 1 },
  'G1-R05': { 'process.start.call': 1 },
  'G1-R06': { 'process.start.call': 1 },
  'G1-R07': { 'process.start.call': 0 },
  'G1-R08': { 'launcher.handle.call': 1 },
  'G1-R09': { 'process.start.call': 0 },
  'G1-R19': { 'process.start.call': 0 },
  'G1-R22': { 'process.start.call': 0 },
  'G1-S08': { 'process.start.call': 0 },
  'G1-R21': { 'process.start.call': 0 },
  'G1-S10': { 'runtime.job-control.dispatch:2': 1 },
}

function add(
  id: string,
  subject: RuntimeSubject,
  fixture: string,
  result: string,
  require: readonly string[],
  forbid: readonly string[] = [],
  before?: readonly (readonly [string, string])[],
  outputIncludes?: readonly string[],
  outputExcludes?: readonly string[],
) {
  if (definitions.has(id)) throw new Error(`duplicate runtime-red scenario ${id}`)
  definitions.set(id, {
    subject,
    fixture,
    result,
    require,
    forbid,
    ...(before ? { before } : {}),
    ...(outputIncludes ? { outputIncludes } : {}),
    ...(outputExcludes ? { outputExcludes } : {}),
  })
}

function addMany(
  ids: readonly string[],
  subject: RuntimeSubject,
  fixture: string,
  result: string,
  require: readonly string[],
  forbid: readonly string[] = [],
  before?: readonly (readonly [string, string])[],
  outputIncludes?: readonly string[],
  outputExcludes?: readonly string[],
) {
  for (const id of ids) add(id, subject, fixture, result, require, forbid, before, outputIncludes, outputExcludes)
}

add('G1-P01', 'application', 'pair-hidden-tty', 'application:exit:0', [
  'io.readHidden',
  'composition.pairing',
  'application.entry:argv:rejected',
  'application.entry:environment:rejected',
  'application.entry:http:rejected',
  'application.entry:wire:rejected',
])
add('G1-P02', 'pairing', 'redeem-success', 'pairing:success', ['transport.redeem:https://example.test', 'transport.redirect:error'], ['transport.redirect:follow'])
add('G1-P03', 'pairing', 'redeem-success', 'pairing:success', ['transport.redeem:/api/runner/v1/pair', 'transport.confirm:/api/runner/v1/pair/confirm', 'transport.media:application/json'])
add('G1-P04', 'pairing', 'redeem-success', 'pairing:success', ['transport.body:code+runner'], ['transport.body:token', 'transport.body:workload-secret'])
add('G1-P05', 'pairing', 'redeem-extra-fields', 'pairing:success', ['store.commitPending:declared-envelope', 'clock.pendingSince'], ['store.commitPending:unknown-field'])
add('G1-P08', 'pairing', 'redeem-wrong-media', 'pairing:error:malformed-response', ['transport.media:other'], ['store.commitPending', 'transport.confirm'])
add('G1-P09', 'pairing', 'redeem-success', 'pairing:success', ['store.commitPending', 'transport.confirm'], [], [['store.commitPending', 'transport.confirm']])
add('G1-P10', 'pairing', 'pending-store-failure', 'pairing:error:store-failed', ['store.commitPending:storage-unavailable'], ['transport.confirm', 'store.settle'])
add('G1-P11', 'pairing', 'proof-vector', 'pairing:success', ['transport.confirm:proof-bound', 'transport.confirm:nonce-bound'], ['transport.confirm:bearer-token'])
add(
  'G1-P12',
  'pairing',
  'proof-vector',
  'pairing:success',
  ['transport.confirm:tokenProof', 'transport.bearer-leak:false'],
  ['transport.confirm:bearer-token', 'transport.bearer-leak:true'],
  undefined,
  pairingSecrecySinks.map(pairingSecrecySinkMarker),
  [pairingFixtureBearer],
)
add('G1-P15', 'pairing', 'confirm-network-loss', 'pairing:error:unreachable', ['store.markConfirmationUnknown', 'store.snapshot:pending'], ['store.release', 'store.settle'])
add('G1-P16', 'pairing', 'resume-pending', 'pairing:resume:success', ['store.snapshot:pending', 'transport.confirm:repeat', 'store.settle'])
add(
  'G1-P18',
  'pairing',
  'confirmation-deadline-uncertain',
  'pairing:error:confirmation-uncertain',
  ['clock.deadline:600000', 'transport.confirm:final', 'transport.confirm:503', 'store.markConfirmationUnknown'],
  ['store.revoke'],
  [['clock.deadline:600000', 'transport.confirm:final'], ['transport.confirm:final', 'transport.confirm:503'], ['transport.confirm:503', 'store.markConfirmationUnknown']],
)
add('G1-P19', 'pairing', 'reservation-in-progress', 'pairing:error:pairing-in-progress', ['store.reserve:pairing-in-progress'], ['transport.redeem', 'store.commitPending'])
add('G1-P20', 'pairing', 'http-status-matrix', 'pairing:status-matrix', ['pairing.status-matrix:complete', 'pairing.status:redeem-204-body:malformed-response', 'pairing.status:confirm-204-body:malformed-response'])
add('G1-P21', 'pairing', 'confirm-terminal-refusal', 'pairing:error:refused', ['transport.confirm:403', 'store.revoke'], ['transport.confirm:retry'])
add('G1-P22', 'runtime', 'websocket-auth-revoked', 'runtime:auth-revoked', ['runtime.auth-failed:401', 'pairing.revoke'], ['runtime.reconnect'])
add('G1-P23', 'pairing', 'pending-superseded', 'pairing:error:superseded', ['store.commitPending:superseded', 'store.snapshot:new-binding'], ['store.settle:old-binding', 'store.revoke:new-binding'])
add('G1-P25', 'pairing', 'redeem-response-lost', 'pairing:error:unreachable', ['transport.redeem:lost-response', 'store.release'], ['transport.redeem:retry', 'store.commitPending'])

add('G1-N01', 'job-control', 'v2-valid-session', 'job-control:effects', ['launcher.handle', 'effect.send:SESSION_ACCEPTED'])
addMany(['G1-N02', 'G1-N03', 'G1-N08'], 'job-control', 'v1-session', 'job-control:effects', ['effect.close:unsupported-session-launch'], ['launcher.handle'])
add('G1-N04', 'runtime', 'negotiate-highest-v2', 'runtime:connected:v2', ['runtime.hello:1-2', 'runtime.job-control.recover:2', 'runtime.job-control-open', 'runtime.stop:confirmed'])
add('G1-N05', 'runtime', 'negotiate-no-overlap', 'runtime:rejected', ['runtime.hello:1-2', 'runtime.connection-count:1'], ['runtime.reconnect', 'runtime.job-control-open'])
add('G1-N06', 'job-control', 'pre-welcome-session', 'job-control:effects', ['effect.close:unsupported-session-launch'], ['launcher.handle'])
add('G1-N07', 'runtime', 'selected-v1-no-launch', 'runtime:connected:v1', ['runtime.job-control.recover:1', 'runtime.job-control-open', 'runtime.stop:confirmed'], ['runtime.send:SESSION_START'])
add('G1-N09', 'job-control', 'v2-extra-fields', 'job-control:effects', ['launcher.handle:declared-fields-only', 'effect.send:SESSION_ACCEPTED'], ['launcher.handle:forbidden-field'])
add('G1-N10', 'job-control', 'v2-unknown-closed-enum', 'job-control:effects', ['effect.close:invalid-session-launch'], ['launcher.handle'])
add('G1-N11', 'job-control', 'v2-oversized-payload', 'job-control:effects', ['effect.close:invalid-session-launch'], ['launcher.handle'])
add('G1-N12', 'job-control', 'v2-authoritative-channel', 'job-control:effects', ['effect.channel:job-control', 'launcher.handle:once'], ['effect.channel:competing'])
add(
  'G1-N13',
  'runtime',
  'reconnect-negotiate-before-session',
  'runtime:connected:v2',
  [
    'runtime.reconnect',
    'runtime.connection-count:[2]',
    'runtime.protocol-recovery:2:connection:[2]',
    'runtime.job-control-recovery:connection:>=2',
    'runtime.stop:confirmed',
  ],
  ['runtime.launch-before-welcome'],
  [
    ['runtime.connection-count:[2]', 'runtime.protocol-recovery:2:connection:[2]'],
    ['runtime.protocol-recovery:2:connection:[2]', 'runtime.job-control-recovery:connection:>=2'],
  ],
)

add('G1-L01', 'job-control', 'v2-invalid-request-id', 'job-control:effects', ['effect.close:invalid-session-launch'], ['launcher.handle'])
add('G1-L02', 'job-control', 'v2-non-uuid-request-id', 'job-control:effects', ['effect.close:invalid-session-launch'], ['launcher.handle'])
add('G1-L03', 'launcher', 'happy-launch', 'launcher:actions', ['access.resolve:model-profile', 'process.request:terminal-profile'])
add('G1-L04', 'job-control', 'v2-valid-session', 'job-control:effects', ['launcher.target:project+worktree+branch+base+cwd'])
add('G1-L05', 'job-control', 'v2-extra-fields', 'job-control:effects', ['launcher.handle:declared-fields-only'], ['launcher.handle:forbidden-field'])
addMany(
  ['G1-L06', 'G1-L07', 'G1-L08', 'G1-L09', 'G1-L10', 'G1-L11', 'G1-L12'],
  'job-control',
  'v2-forbidden-field',
  'job-control:effects',
  ['launcher.handle:declared-fields-only', 'effect.send:SESSION_ACCEPTED'],
  ['launcher.handle:forbidden-field'],
)
add('G1-L13', 'launcher', 'happy-launch', 'launcher:actions', ['projects.get', 'access.resolve'], ['projects.create'])
add('G1-L14', 'launcher', 'happy-launch-with-decoys', 'launcher:actions', ['access.resolve:exact-model-profile'], ['access.resolve:default', 'access.resolve:sole-profile'])
add('G1-L15', 'launcher', 'happy-launch', 'launcher:actions', ['process.start:catalog-command'], ['process.start:wire-command'])
add('G1-L16', 'launcher', 'happy-launch-api-key', 'launcher:actions', ['process.start:profile-key'], ['process.start:alternate-key'])
add('G1-L17', 'launcher', 'happy-launch-local-endpoint', 'launcher:actions', ['process.start:endpoint-secret-env'], ['action.sensitive-field', 'receipt.endpoint-address'])
add('G1-L18', 'launcher', 'happy-launch-subscription', 'launcher:actions', ['process.start:subscription-login'])
add('G1-L19', 'home', 'duplicate-local-configuration', 'home:failed:config-duplicate', ['storage.read:configuration', 'home.failure:config-duplicate'])
const accessReasons = [
  ['G1-L20', 'unknown-profile'], ['G1-L21', 'runtime-unknown'], ['G1-L22', 'runtime-unavailable'],
  ['G1-L23', 'runtime-unauthenticated'], ['G1-L24', 'access-unsupported'], ['G1-L25', 'unknown-key'],
  ['G1-L26', 'key-provider-mismatch'], ['G1-L27', 'unknown-endpoint'], ['G1-L28', 'endpoint-unavailable'],
  ['G1-L29', 'model-unavailable'], ['G1-L30', 'profile-incomplete'],
] as const
for (const [id, reason] of accessReasons) {
  add(id, 'launcher', `access-refusal-${reason}`, 'launcher:actions', [`action.refused:${reason}`, 'access.resolve'], ['process.start', 'channel.open'])
}
add('G1-L31', 'job-control', 'v2-unsafe-identifier', 'job-control:effects', ['effect.close:invalid-session-launch'], ['launcher.handle'])
add('G1-L32', 'launcher', 'refusal-vocabulary', 'launcher:actions', ['action.refused:at-capacity', 'action.refusal-vocabulary:closed'])
add('G1-L33', 'launcher', 'project-unknown', 'launcher:actions', ['action.refused:project-unknown', 'action.requestId'])
add('G1-L34', 'launcher', 'happy-launch', 'launcher:actions', ['receipts.claim:once', 'process.start:once', 'action.accepted'], [], [['receipts.claim', 'action.accepted']])
add('G1-L35', 'launcher', 'happy-launch-api-key', 'launcher:actions', ['action.started', 'receipt.sensitivity:checked'], ['action.sensitive-field', 'receipt.sensitive-field'])
add('G1-L36', 'launcher', 'happy-launch', 'launcher:actions', ['access.resolve:model-profile', 'process.request:terminal-profile'], ['process.request:remote-shell'])

add('G1-W01', 'launcher', 'happy-launch', 'launcher:actions', ['projects.get:project-id', 'worktree.prepare:local-repo-root'], ['worktree.prepare:remote-path'])
add('G1-W02', 'launcher', 'happy-launch', 'launcher:actions', ['worktree.prepare:branch+base+name+cwd'])
add('G1-W03', 'launcher', 'happy-launch', 'launcher:actions', ['worktree.prepare:local-mapping'], ['worktree.prepare:absolute-wire-path'])
add('G1-W04', 'launcher', 'grant-revoked-before-spawn', 'launcher:actions', ['worktree.verify:path-not-granted', 'action.failed:path-not-granted'], ['process.start'])
add('G1-W05', 'launcher', 'same-target-distinct-requests', 'launcher:actions', ['worktree.prepare:same-target-evidence', 'worktree.prepare:deterministic-path'])
add('G1-W06', 'launcher', 'same-target-distinct-requests', 'launcher:actions', ['worktree.prepare:reused', 'worktree.register.call'])
add('G1-W07', 'launcher', 'worktree-conflict', 'launcher:actions', ['action.failed:worktree-conflict'], ['process.start'])
add('G1-W08', 'launcher', 'git-invalid-branch', 'launcher:actions', ['stimulus.branch:git-invalid', 'action.refused:worktree-invalid'], ['action.accepted', 'worktree.prepare.call'])
add(
  'G1-W09',
  'launcher',
  'concurrent-same-lane',
  'launcher:actions',
  ['worktree.prepare:max-active:1', 'process.start:once'],
)
add('G1-W10', 'launcher', 'provision-failure-owned', 'launcher:actions', ['worktree.rollback:owned', 'action.failed:provision-failed'])
add('G1-W11', 'launcher', 'provision-failure-unowned', 'launcher:actions', ['worktree.rollback:not-owned', 'action.failed:recovery-uncertain'])
add('G1-W13', 'launcher', 'recover-worktree-mismatch', 'launcher:actions', ['worktree.inspect:mismatch', 'action.failed:recovery-uncertain'], ['process.start', 'worktree.rollback'])
add('G1-W14', 'launcher', 'provision-failure-owned', 'launcher:actions', ['action.accepted', 'worktree.prepare.call', 'action.failed:provision-failed', 'action.requestId'], ['process.start', 'channel.open'], [['action.accepted', 'worktree.prepare.call'], ['worktree.prepare.call', 'action.failed:provision-failed']])

add('G1-C01', 'launcher', 'happy-launch', 'launcher:actions', ['channel.open:once', 'process.start:once', 'action.started'])
add('G1-C02', 'launcher', 'happy-launch', 'launcher:actions', ['identifier.nextSessionId', 'channel.open:runner-id'], ['action.sensitive-field', 'receipt.secret'])
add('G1-C03', 'launcher', 'happy-launch', 'launcher:actions', ['action.started:request+channel+session'])
add('G1-C04', 'launcher', 'happy-launch', 'launcher:actions', ['action.accepted', 'action.started'], [], [['receipts.claim', 'action.accepted'], ['receipts.replace:started', 'action.started']])
add('G1-C05', 'launcher', 'known-started-replay', 'launcher:actions', ['receipts.lookup:receipt', 'action.started:stable-correlation'], ['process.start'])
add('G1-C06', 'launcher', 'happy-launch', 'launcher:actions', ['process.start:once', 'process.session-bound'])
add('G1-C07', 'launcher', 'terminal-profile-mismatch', 'launcher:actions', ['process.request:bound-terminal-profile'], ['process.request:model-profile-as-terminal'])
add('G1-C08', 'terminal-host', 'terminal-ready-metadata', 'terminal:ready', ['terminal.ready:session+profile+cwd+shell+pid'])
add('G1-C09', 'launcher', 'process-failure-after-channel', 'launcher:actions', ['action.failed:spawn-failed', 'channel.close'])
add('G1-C10', 'launcher', 'process-failure-after-channel', 'launcher:actions', ['receipt.failed:spawn-failed', 'action.failed:spawn-failed'])
add(
  'G1-C11',
  'terminal-host',
  'terminal-exit-replay',
  'terminal:finished',
  [
    'terminal.exit:sequenced',
    'terminal.sequence:pre-disconnect:',
    'terminal.disconnect:before-exit-ack',
    'terminal.reconnect:after-exit',
    'terminal.sequence:post-reconnect:',
    'terminal.exit:replayed:same-sequence',
    'terminal.sequence:replay-next-contiguous',
    'channel.close:after-exit-replay',
  ],
  [],
  [
    ['terminal.sequence:pre-disconnect:', 'terminal.disconnect:before-exit-ack'],
    ['terminal.disconnect:before-exit-ack', 'terminal.reconnect:after-exit'],
    ['terminal.reconnect:after-exit', 'terminal.sequence:post-reconnect:'],
    ['terminal.sequence:post-reconnect:', 'terminal.exit:replayed:same-sequence'],
    ['terminal.exit:replayed:same-sequence', 'terminal.sequence:replay-next-contiguous'],
    ['terminal.sequence:replay-next-contiguous', 'channel.close:after-exit-replay'],
  ],
)
add(
  'G1-C12',
  'terminal-host',
  'terminal-resume',
  'terminal:resumed',
  [
    'terminal.sequence:pre-disconnect-high-water:',
    'terminal.sequence:post-reconnect:',
    'terminal.resume:same-channel+token+sequence',
  ],
  ['terminal.replacement'],
  [
    ['terminal.sequence:pre-disconnect-high-water:', 'terminal.sequence:post-reconnect:'],
    ['terminal.sequence:post-reconnect:', 'terminal.resume:same-channel+token+sequence'],
  ],
)
add(
  'G1-C13',
  'terminal-host',
  'terminal-reset',
  'terminal:reset',
  [
    'terminal.sequence:pre-disconnect-high-water:',
    'terminal.sequence:reset:',
    'terminal.reset:forward-only',
    'terminal.reset:watermark-advances-pre-disconnect',
    'terminal.post-reset:all-advance',
    'terminal.correlation:unchanged',
  ],
  [],
  [
    ['terminal.sequence:pre-disconnect-high-water:', 'terminal.sequence:reset:'],
    ['terminal.sequence:reset:', 'terminal.reset:watermark-advances-pre-disconnect'],
    ['terminal.reset:watermark-advances-pre-disconnect', 'terminal.post-reset:all-advance'],
  ],
)
add('G1-C14', 'launcher', 'access-refusal-unknown-profile', 'launcher:actions', ['action.refused:unknown-profile'], ['channel.open', 'process.start'])
add('G1-C15', 'launcher', 'recover-exact-session', 'launcher:actions', ['process.inspect:exact', 'process.adopt', 'action.started:new-channel+stable-session'], ['process.start'])
add('G1-C16', 'job-control', 'v2-launcher-refusal', 'job-control:effects', ['effect.send:SESSION_REFUSED', 'effect.channel:job-control', 'effect.requestId'])

add('G1-R01', 'launcher', 'duplicate-exact-request', 'launcher:actions', ['action.replay:same-outcome', 'receipts.lookup:known'])
add('G1-R02', 'launcher', 'canonical-body-reordered', 'launcher:actions', ['stimulus.fingerprint:same', 'action.replay:same-outcome'])
add('G1-R03', 'launcher', 'duplicate-different-body', 'launcher:actions', ['action.refused:request-conflict', 'receipt.first:immutable'])
add('G1-R04', 'launcher', 'duplicate-different-body', 'launcher:actions', ['action.refused:request-conflict', 'action.requestId'])
add('G1-R05', 'launcher', 'concurrent-exact-duplicate', 'launcher:actions', ['receipts.claim:atomic-one', 'process.start:once'])
add('G1-R06', 'launcher', 'concurrent-different-body', 'launcher:actions', ['receipts.claim:one-winner', 'action.refused:request-conflict'], ['process.start:second'])
add('G1-R07', 'launcher', 'known-terminal-replay', 'launcher:actions', ['receipts.lookup:tombstone', 'action.replay:terminal', 'action.requestId'], ['process.start'])
add('G1-R08', 'job-control', 'v2-frame-replay', 'job-control:effects', ['launcher.handle.call', 'effect.replay:same-outcome'])
add('G1-R09', 'launcher', 'known-started-replay', 'launcher:actions', ['receipts.lookup:receipt', 'action.started:stable-correlation'], ['process.start'])
add('G1-R10', 'launcher', 'recover-exact-session', 'launcher:actions', ['receipts.recover', 'process.adopt', 'action.started'], ['process.start'])
add('G1-R11', 'launcher', 'recover-session-mismatch', 'launcher:actions', ['process.inspect:mismatch', 'action.failed:recovery-uncertain'], ['process.start', 'process.terminate', 'worktree.rollback'])
add('G1-R12', 'launcher', 'happy-launch', 'launcher:actions', ['receipt.finished', 'action.finished'], [], [['receipts.replace:finished', 'action.finished']])
add('G1-R13', 'launcher', 'project-unknown', 'launcher:actions', ['audit.refused', 'action.refused:project-unknown'], [], [['audit.refused', 'action.refused']])
add('G1-R14', 'ledger', 'persist-schema-v1', 'ledger:replace:updated', ['storage.replace:receipt-fields-complete', 'storage.replace:sensitive-fields-absent'], ['storage.replace:secret', 'storage.replace:launch-plan'])
add('G1-R15', 'ledger', 'compact-after-24h', 'ledger:compact:complete', ['storage.replace:receipt-to-tombstone', 'clock:24h'])
add('G1-R16', 'ledger', 'global-capacity-matrix', 'ledger:capacity-matrix:complete', ['capacity.receipts-count:blocked', 'capacity.receipts-bytes:blocked', 'capacity.inflight:blocked', 'capacity.tombstones-count:preserved', 'capacity.tombstones-bytes:preserved'])
add('G1-R17', 'launcher', 'tombstone-retention-retry', 'launcher:actions', [
  'receipts.lookup:tombstone',
  'receipt.tombstone:replayed-before-expiry',
  'receipt.tombstone:deleted-after-retention',
  'receipt.tombstone:request-expired',
  'action.refused:request-expired',
  'action.requestId',
], ['receipts.claim', 'process.start'])
add('G1-R18', 'ledger', 'compact-oldest-first', 'ledger:compact:complete', ['storage.replace:oldest-expired-first', 'storage.replace:unexpired-preserved', 'storage.replace:live-preserved', 'storage.replace:inflight-preserved'], ['storage.replace:unexpired-evicted', 'storage.replace:live-evicted', 'storage.replace:inflight-evicted'])
add('G1-R19', 'launcher', 'binding-mismatch', 'launcher:actions', ['binding.compare:mismatch', 'action.refused:binding-mismatch'], ['receipts.lookup', 'action.accepted'])
add('G1-R20', 'job-control', 'v2-invalid-request-id', 'job-control:effects', ['effect.close:invalid-session-launch'], ['launcher.handle'])
add(
  'G1-R21',
  'launcher',
  'capacity-durability-matrix',
  'launcher:capacity-durability',
  [
    'capacity.header:durable',
    'capacity.audit:refused',
    'capacity.audit:correlated',
    'action.refused:at-capacity',
    'capacity.action:at-capacity:correlated',
    'capacity.header:mutation-failed',
    'capacity.close:header-mutation',
    'capacity.audit:mutation-failed',
    'capacity.close:audit-mutation',
    'capacity.process-starts:0',
  ],
  [],
  [
    ['capacity.header:durable', 'capacity.audit:correlated'],
    ['capacity.audit:correlated', 'action.refused:at-capacity'],
    ['action.refused:at-capacity', 'capacity.action:at-capacity:correlated'],
  ],
)
add('G1-R22', 'launcher', 'known-terminal-replay', 'launcher:actions', ['receipts.lookup:tombstone', 'action.replay:terminal'], ['process.start'])
add('G1-R25', 'launcher', 'receipt-outcomes-observable', 'launcher:actions', [
  'receipt.outcome:conflict:correlated',
  'receipt.outcome:expiry:correlated',
  'receipt.outcome:retained-completion',
  'receipt.outcome:retained-replay',
  'receipt.outcome:capacity:correlated',
])

add('G1-S01', 'launcher', 'happy-launch', 'launcher:actions', ['action.accepted', 'action.started'])
add('G1-S02', 'launcher', 'deadline-controlled-launch', 'launcher:actions', ['clock.initial<=5000', 'clock.progress<=180000', 'action.started'])
add('G1-S03', 'launcher', 'access-refusal-unknown-profile', 'launcher:actions', ['action.refused:unknown-profile'], ['process.start'])
add('G1-S04', 'runtime', 'runner-paused-offline', 'runtime:offline-visible', ['runtime.stop:requested', 'runtime.unsent:not-accepted'])
add('G1-S06', 'job-control', 'v2-malformed-safe-id', 'job-control:effects', ['effect.send:SESSION_REFUSED:invalid-request', 'effect.requestId'], ['launcher.handle'])
add('G1-S07', 'job-control', 'v1-session', 'job-control:effects', ['effect.close:unsupported-session-launch'], ['launcher.handle'])
add('G1-S08', 'launcher', 'audit-storage-failure', 'launcher:actions', ['action.close:storage-unavailable'], ['action.failed'])
add('G1-S09', 'launcher', 'capacity-conflict-expiry-observable', 'launcher:actions', ['action.refused:at-capacity', 'action.requestId'])
add(
  'G1-S10',
  'runtime',
  'ambiguous-job-control-loss',
  'runtime:storage-uncertain',
  [
    'runtime.job-control.dispatch:2',
    'runtime.channel-loss:nonterminal',
    'runtime.reconnect',
    'runtime.job-control-recovery:connection:>=2',
    'runtime.ambiguous-loss:quiet-window:begin:connection:>=2',
    'runtime.ambiguous-loss:quiet-window:end:connection:>=2',
    'runtime.redrive:stopped',
  ],
  [],
  [
    ['runtime.channel-loss:nonterminal', 'runtime.reconnect'],
    ['runtime.reconnect', 'runtime.job-control-recovery:connection:>=2'],
    ['runtime.job-control-recovery:connection:>=2', 'runtime.ambiguous-loss:quiet-window:begin:connection:>=2'],
    ['runtime.ambiguous-loss:quiet-window:begin:connection:>=2', 'runtime.ambiguous-loss:quiet-window:end:connection:>=2'],
    ['runtime.ambiguous-loss:quiet-window:end:connection:>=2', 'runtime.redrive:stopped'],
  ],
)
add('G1-S11', 'launcher', 'recover-session-mismatch', 'launcher:actions', ['action.failed:recovery-uncertain'], ['process.start', 'process.terminate'])
add('G1-S12', 'launcher', 'happy-launch', 'launcher:actions', ['action.started'], [], [['receipts.replace:started', 'action.started'], ['audit.started', 'action.started']])

export function scenarioFor(obligation: RuntimeRedObligation): RuntimeScenario {
  const definition = definitions.get(obligation.id)
  if (!definition) throw new Error(`no discriminating runtime-red scenario for ${obligation.id}`)
  const tokens: Record<string, string> = {
    '{id}': obligation.id,
    '{requestId}': requestIdFor(obligation.id),
  }
  const expand = (value: string) => Object.entries(tokens).reduce((result, [token, replacement]) => result.replaceAll(token, replacement), value)
  const oracle: RuntimeOracle = {
    result: expand(definition.result),
    require: [...definition.require.map(expand), materialRequirement(definition.subject, obligation.id, definition.fixture)],
    forbid: (definition.forbid ?? []).map(expand),
    ...(definition.before ? { before: definition.before.map(([first, second]) => [expand(first), expand(second)] as const) } : {}),
    ...(exactEventCounts[obligation.id] ? { counts: exactEventCounts[obligation.id] } : {}),
    ...(definition.outputIncludes ? { outputIncludes: definition.outputIncludes.map(expand) } : {}),
    ...(definition.outputExcludes ? { outputExcludes: definition.outputExcludes.map(expand) } : {}),
  }
  return {
    obligationId: obligation.id,
    assertion: obligation.assertion,
    subject: definition.subject,
    fixture: definition.fixture,
    stimulus: `${definition.fixture}:${obligation.id}`,
    oracle,
  }
}

function materialRequirement(subject: RuntimeSubject, id: string, fixture: string): string {
  if (subject === 'pairing') {
    if (fixture === 'resume-pending' || fixture.startsWith('confirmation-deadline')) return 'store.snapshot:pending'
    return 'input.code:accepted'
  }
  if (subject === 'job-control') return `effect.channel:job-control-${id.toLowerCase()}`
  if (subject === 'launcher') return requestIdFor(id)
  if (subject === 'terminal-host') return `terminal.fixture:${fixture}`
  if (subject === 'ledger') return `storage.fixture:${fixture}`
  if (subject === 'home') return `storage.fixture:${fixture}`
  if (subject === 'runtime') return `runtime.fixture:${fixture}`
  return `application.fixture:${fixture}`
}

export function runtimeScenarioIds(): readonly string[] {
  return [...definitions.keys()]
}
