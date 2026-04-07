'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeFlagsDocument,
  applyFlagUpdates,
  serializeFlagsDocument,
  getFlagsReadRef,
  isPublishableStatus,
  buildRestartPatch,
  hasDeploymentRolledOut,
} = require('./lib');

function buildDocument() {
  return {
    $schema: 'https://flagd.dev/schema/v0/flags.json',
    flags: {
      productCatalogFailure: {
        description: 'Boolean toggle',
        state: 'ENABLED',
        variants: {
          on: true,
          off: false,
        },
        defaultVariant: 'off',
      },
      paymentFailure: {
        description: 'Percentage flag',
        state: 'ENABLED',
        variants: {
          '100%': 1,
          off: 0,
        },
        defaultVariant: 'off',
      },
    },
  };
}

test('normalizeFlagsDocument maps on/off flags to enabled booleans', () => {
  const flags = normalizeFlagsDocument(buildDocument());
  const booleanFlag = flags.find((flag) => flag.flagKey === 'productCatalogFailure');
  const complexFlag = flags.find((flag) => flag.flagKey === 'paymentFailure');

  assert.equal(booleanFlag.enabled, false);
  assert.equal(booleanFlag.supported, true);
  assert.equal(complexFlag.supported, false);
});

test('applyFlagUpdates updates only requested boolean flags', () => {
  const { nextDocument, changedFlags } = applyFlagUpdates(buildDocument(), [
    { flagKey: 'productCatalogFailure', enabled: true },
  ]);

  assert.deepEqual(changedFlags, ['productCatalogFailure']);
  assert.equal(nextDocument.flags.productCatalogFailure.defaultVariant, 'on');
  assert.equal(nextDocument.flags.paymentFailure.defaultVariant, 'off');
});

test('applyFlagUpdates rejects unsupported flag shapes', () => {
  assert.throws(
    () =>
      applyFlagUpdates(buildDocument(), [{ flagKey: 'paymentFailure', enabled: true }]),
    /not a supported on\/off toggle/,
  );
});

test('serializeFlagsDocument preserves trailing newline', () => {
  const serialized = serializeFlagsDocument(buildDocument());
  assert.match(serialized, /\n$/);
});

test('getFlagsReadRef prefers work branch only when a PR is open', () => {
  assert.equal(getFlagsReadRef({ pullRequest: null }, 'main', 'admin/flag-toggles'), 'main');
  assert.equal(
    getFlagsReadRef({ pullRequest: { number: 1 } }, 'main', 'admin/flag-toggles'),
    'admin/flag-toggles',
  );
});

test('isPublishableStatus requires an open mergeable PR', () => {
  assert.equal(isPublishableStatus({ pullRequest: null }), false);
  assert.equal(
    isPublishableStatus({ pullRequest: { mergeable: false, mergeableState: 'dirty' } }),
    false,
  );
  assert.equal(
    isPublishableStatus({ pullRequest: { mergeable: true, mergeableState: 'clean' } }),
    true,
  );
});

test('buildRestartPatch creates a deployment annotation patch', () => {
  const patch = buildRestartPatch('2026-04-07T12:00:00.000Z');
  assert.equal(
    patch.spec.template.metadata.annotations['astroshop.demo/restartedAt'],
    '2026-04-07T12:00:00.000Z',
  );
});

test('hasDeploymentRolledOut recognizes ready deployments', () => {
  assert.equal(
    hasDeploymentRolledOut({
      metadata: { generation: 2 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 2,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    }),
    true,
  );

  assert.equal(
    hasDeploymentRolledOut({
      metadata: { generation: 2 },
      spec: { replicas: 1 },
      status: {
        observedGeneration: 1,
        updatedReplicas: 1,
        availableReplicas: 1,
      },
    }),
    false,
  );
});
