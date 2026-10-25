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

const {
  getToggleVariants,
  parseDeploymentList,
  parseOnVariants,
} = require('./lib');

test('without an on-variant mapping, non-boolean flags stay unsupported (unchanged behaviour)', () => {
  const flags = normalizeFlagsDocument(buildDocument());
  const complexFlag = flags.find((flag) => flag.flagKey === 'paymentFailure');
  assert.equal(complexFlag.supported, false);
  assert.equal(complexFlag.onVariant, null);
  assert.throws(
    () => applyFlagUpdates(buildDocument(), [{ flagKey: 'paymentFailure', enabled: true }]),
    /not a supported on\/off toggle/,
  );
});

test('boolean flags toggle on/off as before, mapping or not', () => {
  const onVariants = parseOnVariants('paymentFailure=100%');
  const { nextDocument, changedFlags } = applyFlagUpdates(
    buildDocument(),
    [{ flagKey: 'productCatalogFailure', enabled: true }],
    onVariants,
  );
  assert.deepEqual(changedFlags, ['productCatalogFailure']);
  assert.equal(nextDocument.flags.productCatalogFailure.defaultVariant, 'on');
  assert.deepEqual(getToggleVariants('productCatalogFailure', buildDocument().flags.productCatalogFailure, onVariants), {
    on: 'on',
    off: 'off',
  });
});

test('a mapped flag toggles between its on variant and off', () => {
  const onVariants = parseOnVariants('paymentFailure=100%');
  const normalized = normalizeFlagsDocument(buildDocument(), onVariants).find((flag) => flag.flagKey === 'paymentFailure');
  assert.equal(normalized.supported, true);
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.onVariant, '100%');

  const on = applyFlagUpdates(buildDocument(), [{ flagKey: 'paymentFailure', enabled: true }], onVariants);
  assert.deepEqual(on.changedFlags, ['paymentFailure']);
  assert.equal(on.nextDocument.flags.paymentFailure.defaultVariant, '100%');
  assert.equal(normalizeFlagsDocument(on.nextDocument, onVariants).find((f) => f.flagKey === 'paymentFailure').enabled, true);

  const off = applyFlagUpdates(on.nextDocument, [{ flagKey: 'paymentFailure', enabled: false }], onVariants);
  assert.equal(off.nextDocument.flags.paymentFailure.defaultVariant, 'off');
});

test('a mapped flag is not toggleable when the variant is missing or another variant is active', () => {
  const doc = buildDocument();
  assert.equal(getToggleVariants('paymentFailure', doc.flags.paymentFailure, { paymentFailure: '50%' }), null);
  assert.equal(getToggleVariants('paymentFailure', doc.flags.paymentFailure, { paymentFailure: 'off' }), null);
  doc.flags.paymentFailure.variants['50%'] = 0.5;
  doc.flags.paymentFailure.defaultVariant = '50%';
  assert.equal(getToggleVariants('paymentFailure', doc.flags.paymentFailure, { paymentFailure: '100%' }), null);
});

test('parseOnVariants reads flagKey=variant pairs and rejects malformed entries', () => {
  assert.deepEqual(parseOnVariants(''), {});
  assert.deepEqual(parseOnVariants(undefined), {});
  assert.deepEqual(parseOnVariants(' paymentFailure=100% , imageSlowLoad=10sec '), {
    paymentFailure: '100%',
    imageSlowLoad: '10sec',
  });
  assert.throws(() => parseOnVariants('paymentFailure'), /expected flagKey=variant/);
  assert.throws(() => parseOnVariants('=100%'), /expected flagKey=variant/);
});

test('parseDeploymentList keeps order, removes duplicates, defaults to the fallback and validates names', () => {
  assert.deepEqual(parseDeploymentList('', 'flagd'), ['flagd']);
  assert.deepEqual(parseDeploymentList(undefined, 'flagd'), ['flagd']);
  assert.deepEqual(parseDeploymentList('flagd, checkout,flagd', 'flagd'), ['flagd', 'checkout']);
  assert.throws(() => parseDeploymentList('flagd,Checkout', 'flagd'), /Invalid deployment name/);
  assert.throws(() => parseDeploymentList('../secrets', 'flagd'), /Invalid deployment name/);
});
