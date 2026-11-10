'use strict';

function isBooleanToggleFlag(flag) {
  if (!flag || typeof flag !== 'object') {
    return false;
  }

  const variants = flag.variants;
  return (
    variants &&
    typeof variants === 'object' &&
    variants.on === true &&
    variants.off === false &&
    (flag.defaultVariant === 'on' || flag.defaultVariant === 'off')
  );
}

// Flags that are not plain on/off booleans (for example paymentFailure, whose variants are "100%" ... "off") can be
// toggled when they have an "off" variant and a configured "on" variant: FLAG_ON_VARIANTS="paymentFailure=100%".
function parseOnVariants(value) {
  const map = {};
  for (const entry of String(value || '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`Invalid on-variant mapping "${entry}"; expected flagKey=variant`);
    }
    map[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return map;
}

// Deployments restarted on publish, in order: RESTART_DEPLOYMENTS="flagd,checkout". Defaults to flagd alone.
function parseDeploymentList(value, fallback) {
  const names = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
  const list = [...new Set(names.length ? names : [fallback])];
  for (const name of list) {
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
      throw new Error(`Invalid deployment name "${name}"`);
    }
  }
  return list;
}

// The variants a flag toggles between, or null when the panel cannot toggle it. Boolean flags toggle on/off as
// before; a mapped flag toggles between its configured "on" variant and "off", but only while it is in one of the
// two, so a flag someone set to another variant (say "50%") is left alone.
function getToggleVariants(flagKey, flag, onVariants = {}) {
  if (isBooleanToggleFlag(flag)) {
    return { on: 'on', off: 'off' };
  }
  if (!flag || typeof flag !== 'object' || !flag.variants || typeof flag.variants !== 'object') {
    return null;
  }

  const on = Object.prototype.hasOwnProperty.call(onVariants, flagKey) ? onVariants[flagKey] : null;
  const has = (variant) => Object.prototype.hasOwnProperty.call(flag.variants, variant);
  if (!on || on === 'off' || !has(on) || !has('off')) {
    return null;
  }
  if (flag.defaultVariant !== on && flag.defaultVariant !== 'off') {
    return null;
  }
  return { on, off: 'off' };
}

function normalizeFlagsDocument(document, onVariants = {}) {
  if (!document || typeof document !== 'object' || !document.flags || typeof document.flags !== 'object') {
    throw new Error('Invalid flag document: missing top-level flags object');
  }

  return Object.entries(document.flags)
    .map(([flagKey, flag]) => {
      const toggle = getToggleVariants(flagKey, flag, onVariants);
      return {
        flagKey,
        description: flag.description || '',
        state: flag.state || 'UNKNOWN',
        defaultVariant: flag.defaultVariant,
        variants: flag.variants || {},
        enabled: flag.defaultVariant === (toggle ? toggle.on : 'on'),
        supported: Boolean(toggle),
        onVariant: toggle ? toggle.on : null,
      };
    })
    .sort((left, right) => left.flagKey.localeCompare(right.flagKey));
}

function applyFlagUpdates(document, requestedUpdates, onVariants = {}) {
  if (!Array.isArray(requestedUpdates) || requestedUpdates.length === 0) {
    throw new Error('At least one flag update is required');
  }

  const nextDocument = JSON.parse(JSON.stringify(document));
  const changedFlags = [];
  const seen = new Set();

  for (const update of requestedUpdates) {
    if (!update || typeof update.flagKey !== 'string' || typeof update.enabled !== 'boolean') {
      throw new Error('Each update must include a flagKey and boolean enabled value');
    }

    if (seen.has(update.flagKey)) {
      throw new Error(`Duplicate update for flag ${update.flagKey}`);
    }
    seen.add(update.flagKey);

    const flag = nextDocument.flags[update.flagKey];
    if (!flag) {
      throw new Error(`Unknown flag ${update.flagKey}`);
    }
    const toggle = getToggleVariants(update.flagKey, flag, onVariants);
    if (!toggle) {
      throw new Error(`Flag ${update.flagKey} is not a supported on/off toggle`);
    }

    const nextVariant = update.enabled ? toggle.on : toggle.off;
    if (flag.defaultVariant !== nextVariant) {
      flag.defaultVariant = nextVariant;
      changedFlags.push(update.flagKey);
    }
  }

  return {
    nextDocument,
    changedFlags,
  };
}

function serializeFlagsDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function getFlagsReadRef(status, baseBranch, workBranch) {
  return status && status.pullRequest ? workBranch : baseBranch;
}

function isPublishableStatus(status) {
  if (!status || !status.pullRequest) {
    return false;
  }

  const mergeable = status.pullRequest.mergeable;
  if (mergeable === false) {
    return false;
  }

  const mergeState = status.pullRequest.mergeableState;
  return mergeState !== 'dirty' && mergeState !== 'unknown';
}

function buildRestartPatch(timestamp) {
  return {
    spec: {
      template: {
        metadata: {
          annotations: {
            'astroshop.demo/restartedAt': timestamp,
          },
        },
      },
    },
  };
}

function hasDeploymentRolledOut(deployment) {
  if (!deployment || !deployment.spec || !deployment.status || !deployment.metadata) {
    return false;
  }

  const desiredReplicas = deployment.spec.replicas ?? 1;
  const observedGeneration = deployment.status.observedGeneration ?? 0;
  const generation = deployment.metadata.generation ?? 0;

  return (
    observedGeneration >= generation &&
    (deployment.status.updatedReplicas ?? 0) >= desiredReplicas &&
    (deployment.status.availableReplicas ?? 0) >= desiredReplicas
  );
}

module.exports = {
  applyFlagUpdates,
  buildRestartPatch,
  getFlagsReadRef,
  hasDeploymentRolledOut,
  isPublishableStatus,
  getToggleVariants,
  isBooleanToggleFlag,
  normalizeFlagsDocument,
  parseDeploymentList,
  parseOnVariants,
  serializeFlagsDocument,
};
