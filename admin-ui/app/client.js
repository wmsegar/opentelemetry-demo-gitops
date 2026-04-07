const state = {
  flags: [],
  draft: new Map(),
  branchStatus: null,
  busy: false,
};

const elements = {
  flags: document.getElementById('flags'),
  saveButton: document.getElementById('save-button'),
  publishButton: document.getElementById('publish-button'),
  message: document.getElementById('message'),
  prLink: document.getElementById('pr-link'),
  branchStatusText: document.getElementById('branch-status-text'),
  publishResultPanel: document.getElementById('publish-result-panel'),
  publishResultText: document.getElementById('publish-result-text'),
};

initialize().catch((error) => {
  showMessage(error.message || 'Failed to load admin UI', 'error');
});

async function initialize() {
  await refresh();
  elements.saveButton.addEventListener('click', saveChanges);
  elements.publishButton.addEventListener('click', publishChanges);
}

async function refresh() {
  const response = await fetch('/admin/api/flags', { credentials: 'same-origin' });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to load flags');
  }

  state.flags = payload.flags;
  state.branchStatus = payload.branchStatus;
  state.draft = new Map(payload.flags.map((flag) => [flag.flagKey, flag.enabled]));
  renderStatus(payload.branchStatus);
  renderFlags();
  updateActionState();
}

function renderStatus(status) {
  if (status.pullRequest) {
    const mergeability = status.publishReady ? 'ready to publish' : 'not ready to publish';
    elements.branchStatusText.textContent = `Working branch ${status.branch.name} has an open PR #${status.pullRequest.number} and is currently ${mergeability}.`;
    elements.prLink.href = status.pullRequest.url;
    elements.prLink.classList.remove('hidden');
  } else if (status.branchExists && status.branch) {
    elements.branchStatusText.textContent = `Working branch ${status.branch.name} exists but does not currently have an open PR. Save a flag change to open a new one.`;
    elements.prLink.classList.add('hidden');
  } else {
    elements.branchStatusText.textContent = 'No admin branch exists yet. Your first save will create a reusable admin branch and open a PR in the fork.';
    elements.prLink.classList.add('hidden');
  }

  if (status.lastPublishResult) {
    elements.publishResultPanel.classList.remove('hidden');
    elements.publishResultText.textContent = `Merged PR #${status.lastPublishResult.pullRequestNumber} and deployed ${status.lastPublishResult.deployedRef} at ${status.lastPublishResult.mergedAt}.`;
  } else {
    elements.publishResultPanel.classList.add('hidden');
  }
}

function renderFlags() {
  elements.flags.innerHTML = '';

  for (const flag of state.flags) {
    const article = document.createElement('article');
    article.className = `flag-card ${flag.supported ? '' : 'flag-card-disabled'}`;

    const title = document.createElement('h3');
    title.textContent = flag.flagKey;
    article.appendChild(title);

    const description = document.createElement('p');
    description.className = 'flag-description';
    description.textContent = flag.description || 'No description provided.';
    article.appendChild(description);

    const meta = document.createElement('p');
    meta.className = 'flag-meta';
    meta.textContent = `State: ${flag.state} | Default variant: ${flag.defaultVariant}`;
    article.appendChild(meta);

    const controls = document.createElement('div');
    controls.className = 'flag-controls';

    const label = document.createElement('label');
    label.className = 'toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.draft.get(flag.flagKey);
    input.disabled = !flag.supported || state.busy;
    input.addEventListener('change', () => {
      state.draft.set(flag.flagKey, input.checked);
      valueText.textContent = input.checked ? 'On' : 'Off';
      updateActionState();
    });

    const slider = document.createElement('span');
    slider.className = 'slider';

    const valueText = document.createElement('span');
    valueText.className = 'toggle-text';
    valueText.textContent = input.checked ? 'On' : 'Off';

    label.appendChild(input);
    label.appendChild(slider);
    controls.appendChild(label);
    controls.appendChild(valueText);

    if (!flag.supported) {
      const unsupported = document.createElement('span');
      unsupported.className = 'unsupported';
      unsupported.textContent = 'Unsupported flag shape';
      controls.appendChild(unsupported);
    }

    article.appendChild(controls);
    elements.flags.appendChild(article);
  }
}

function updateActionState() {
  const changedCount = getChangedFlags().length;
  elements.saveButton.disabled = state.busy || changedCount === 0;
  elements.saveButton.textContent =
    changedCount === 0 ? 'Save changes' : `Save ${changedCount} change${changedCount === 1 ? '' : 's'}`;

  const publishReady =
    state.branchStatus &&
    state.branchStatus.publishReady &&
    state.branchStatus.pullRequest &&
    changedCount === 0 &&
    !state.busy;
  elements.publishButton.disabled = !publishReady;
  elements.publishButton.textContent = publishReady ? 'Merge + Deploy' : 'Publish to Cluster';
}

function getChangedFlags() {
  return state.flags
    .filter((flag) => flag.supported)
    .filter((flag) => state.draft.get(flag.flagKey) !== flag.enabled)
    .map((flag) => ({
      flagKey: flag.flagKey,
      enabled: state.draft.get(flag.flagKey),
    }));
}

async function saveChanges() {
  const flags = getChangedFlags();
  if (flags.length === 0) {
    return;
  }

  state.busy = true;
  updateActionState();
  showMessage('Saving changes through GitHub...', 'info');

  try {
    const response = await fetch('/admin/api/flags/apply', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flags }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to save changes');
    }

    showMessage(
      payload.pullRequest
        ? `Saved ${payload.changedFlags.length} change(s). PR #${payload.pullRequest.number} is ready.`
        : payload.message,
      'success',
    );
    await refresh();
  } catch (error) {
    showMessage(error.message || 'Failed to save changes', 'error');
  } finally {
    state.busy = false;
    renderFlags();
    updateActionState();
  }
}

async function publishChanges() {
  if (!state.branchStatus || !state.branchStatus.pullRequest) {
    return;
  }

  state.busy = true;
  updateActionState();
  renderFlags();
  showMessage('Publishing changes: merging PR, deploying config, and restarting flagd...', 'info');

  try {
    const response = await fetch('/admin/api/flags/publish', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to publish changes');
    }

    showMessage(
      `Published successfully. PR #${payload.pullRequest.number} merged and cluster updated from ${payload.deployedRef}.`,
      'success',
    );
    await refresh();
  } catch (error) {
    showMessage(error.message || 'Failed to publish changes', 'error');
  } finally {
    state.busy = false;
    renderFlags();
    updateActionState();
  }
}

function showMessage(text, tone) {
  elements.message.textContent = text;
  elements.message.className = `message message-${tone}`;
}
