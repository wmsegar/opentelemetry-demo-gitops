'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const {
  normalizeFlagsDocument,
  applyFlagUpdates,
  serializeFlagsDocument,
  getFlagsReadRef,
  isPublishableStatus,
  buildRestartPatch,
  hasDeploymentRolledOut,
} = require('./lib');

const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH || '/admin');
const apiBasePath = `${appBasePath}/api`;
const healthPath = `${appBasePath}/healthz`;
const port = Number(process.env.ADMIN_UI_PORT || '8080');

const config = {
  githubOwner: process.env.GITHUB_OWNER || 'wmsegar',
  githubRepo: process.env.GITHUB_REPO || 'opentelemetry-demo-gitops',
  githubBaseBranch: process.env.GITHUB_BASE_BRANCH || 'main',
  githubWorkBranch: process.env.GITHUB_WORK_BRANCH || 'admin/flag-toggles',
  flagsFilePath:
    process.env.FLAGS_FILE_PATH || 'kustomize/components/flagd-config/demo.flagd.json',
  prTitle: process.env.GITHUB_PR_TITLE || 'Admin UI feature flag updates',
  prBody:
    process.env.GITHUB_PR_BODY ||
    'This PR was created by the Astroshop feature flag admin UI to update demo flag defaults.',
  adminUsername: process.env.ADMIN_UI_USERNAME || '',
  adminPassword: process.env.ADMIN_UI_PASSWORD || '',
  githubToken: process.env.GITHUB_TOKEN || '',
  clusterNamespace: process.env.CLUSTER_NAMESPACE || 'astroshop',
  flagdConfigMapName: process.env.FLAGD_CONFIGMAP_NAME || 'flagd-config',
  flagdDeploymentName: process.env.FLAGD_DEPLOYMENT_NAME || 'flagd',
  rolloutTimeoutMs: Number(process.env.FLAGD_ROLLOUT_TIMEOUT_MS || '120000'),
};

let lastPublishResult = null;

const textFiles = new Map([
  [`${appBasePath}`, loadTextFile('index.html')],
  [`${appBasePath}/`, loadTextFile('index.html')],
  [`${appBasePath}/flags`, loadTextFile('index.html')],
  [`${appBasePath}/flags/`, loadTextFile('index.html')],
  [`${appBasePath}/client.js`, loadTextFile('client.js')],
  [`${appBasePath}/styles.css`, loadTextFile('styles.css')],
]);

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = trimTrailingSlash(url.pathname, appBasePath);

    if (pathname === trimTrailingSlash(healthPath, appBasePath)) {
      return sendJson(response, 200, { status: 'ok' });
    }

    if (pathname.startsWith(appBasePath)) {
      const authResult = requireAuth(request);
      if (!authResult.ok) {
        return sendAuthError(response, authResult);
      }
    }

    if (pathname.startsWith(apiBasePath)) {
      if (request.method === 'GET' && pathname === `${apiBasePath}/flags`) {
        const payload = await handleGetFlags();
        return sendJson(response, 200, payload);
      }

      if (request.method === 'GET' && pathname === `${apiBasePath}/status`) {
        const payload = await getStatus();
        return sendJson(response, 200, payload);
      }

      if (request.method === 'POST' && pathname === `${apiBasePath}/flags/apply`) {
        const body = await readJsonBody(request);
        const payload = await handleApplyFlags(body);
        return sendJson(response, 200, payload);
      }

      if (request.method === 'POST' && pathname === `${apiBasePath}/flags/publish`) {
        const payload = await handlePublish();
        return sendJson(response, 200, payload);
      }

      return sendJson(response, 404, { error: 'Not found' });
    }

    if (textFiles.has(pathname)) {
      const content = textFiles.get(pathname);
      const contentType = pathname.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : pathname.endsWith('.js')
          ? 'application/javascript; charset=utf-8'
          : 'text/html; charset=utf-8';
      return sendText(response, 200, content, contentType);
    }

    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(response, error.statusCode || 500, {
      error: error.message || 'Internal server error',
    });
  }
});

server.listen(port, () => {
  console.log(`Flag admin UI listening on port ${port}`);
});

function loadTextFile(fileName) {
  return fs.readFileSync(path.join(__dirname, fileName), 'utf8');
}

function normalizeBasePath(basePath) {
  const normalized = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return normalized.endsWith('/') && normalized !== '/' ? normalized.slice(0, -1) : normalized;
}

function trimTrailingSlash(value, basePathValue) {
  if (value === basePathValue || value === `${basePathValue}/`) {
    return basePathValue;
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function requireAuth(request) {
  if (!config.adminUsername || !config.adminPassword) {
    return { ok: false, status: 503, error: 'Admin UI auth is not configured' };
  }

  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    return { ok: false, status: 401, error: 'Missing basic auth credentials' };
  }

  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';

  const validUser = safeEqual(username, config.adminUsername);
  const validPassword = safeEqual(password, config.adminPassword);
  if (!validUser || !validPassword) {
    return { ok: false, status: 401, error: 'Invalid credentials' };
  }

  return { ok: true };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sendAuthError(response, result) {
  if (result.status === 401) {
    response.setHeader('WWW-Authenticate', 'Basic realm="Astroshop Flag Admin"');
  }
  return sendJson(response, result.status, { error: result.error });
}

async function handleGetFlags() {
  const status = await getStatus();
  const ref = getFlagsReadRef(status, config.githubBaseBranch, config.githubWorkBranch);
  const remoteFile = await getRemoteFile(ref);
  return {
    source: {
      owner: config.githubOwner,
      repo: config.githubRepo,
      ref,
      path: config.flagsFilePath,
    },
    branchStatus: status,
    flags: normalizeFlagsDocument(remoteFile.document),
  };
}

async function handleApplyFlags(body) {
  assertGitHubToken();

  const updates = body && Array.isArray(body.flags) ? body.flags : null;
  if (!updates) {
    throw new Error('Request body must include a flags array');
  }

  const status = await getStatus();
  await ensureWorkBranch(status);
  const remoteFile = await getRemoteFile(config.githubWorkBranch);
  const { nextDocument, changedFlags } = applyFlagUpdates(remoteFile.document, updates);

  if (changedFlags.length === 0) {
    return {
      changedFlags,
      branch: config.githubWorkBranch,
      pullRequest: status.pullRequest,
      commitSha: null,
      message: 'No flag values changed',
    };
  }

  const commit = await updateRemoteFile({
    branch: config.githubWorkBranch,
    content: serializeFlagsDocument(nextDocument),
    sha: remoteFile.sha,
    message: `Update feature flags: ${changedFlags.join(', ')}`,
  });

  let pullRequest = status.pullRequest;
  if (!pullRequest) {
    pullRequest = await createPullRequest();
  } else {
    pullRequest = await getPullRequestByNumber(pullRequest.number);
  }

  return {
    changedFlags,
    branch: config.githubWorkBranch,
    pullRequest,
    commitSha: commit.commit.sha,
    message: `Updated ${changedFlags.length} flag(s) on ${config.githubWorkBranch}`,
  };
}

async function handlePublish() {
  assertGitHubToken();

  const status = await getStatus();
  if (!status.pullRequest) {
    throw new Error('There is no open admin PR to publish');
  }
  if (!isPublishableStatus(status)) {
    throw new Error('The open admin PR is not currently mergeable');
  }

  const mergedPullRequest = await mergePullRequest(status.pullRequest.number);
  const mergedFile = await getRemoteFile(config.githubBaseBranch);
  const deployedAt = new Date().toISOString();
  const deployResult = await deployFlagsDocument(serializeFlagsDocument(mergedFile.document), deployedAt);

  lastPublishResult = {
    mergedAt: deployedAt,
    mergeCommitSha: mergedPullRequest.sha,
    pullRequestNumber: status.pullRequest.number,
    deployedRef: config.githubBaseBranch,
    configMapUpdated: deployResult.configMapUpdated,
    flagdRestarted: deployResult.flagdRestarted,
    rolloutStatus: deployResult.rolloutStatus,
    message: 'Merged PR and deployed updated flag configuration',
  };

  return {
    pullRequest: {
      ...status.pullRequest,
      state: 'closed',
      merged: true,
    },
    mergeCommitSha: mergedPullRequest.sha,
    deployedRef: config.githubBaseBranch,
    configMapUpdated: deployResult.configMapUpdated,
    flagdRestarted: deployResult.flagdRestarted,
    rolloutStatus: deployResult.rolloutStatus,
    message: 'Merged PR and deployed updated flag configuration',
  };
}

async function getStatus() {
  const branch = await getBranch(config.githubWorkBranch);
  const pullRequest = await getOpenPullRequest();
  return {
    branchExists: Boolean(branch),
    branch: branch ? { name: config.githubWorkBranch, sha: branch.object.sha } : null,
    pullRequest,
    baseBranch: config.githubBaseBranch,
    publishReady: isPublishableStatus({ pullRequest }),
    lastPublishResult,
  };
}

async function ensureWorkBranch(status) {
  if (status.branchExists) {
    return;
  }

  const baseBranch = await getBranch(config.githubBaseBranch);
  if (!baseBranch) {
    throw new Error(`Base branch ${config.githubBaseBranch} was not found`);
  }

  await githubFetch('/git/refs', {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${config.githubWorkBranch}`,
      sha: baseBranch.object.sha,
    }),
  });
}

async function getRemoteFile(ref) {
  const response = await githubFetch(
    `/contents/${encodePath(config.flagsFilePath)}?ref=${encodeURIComponent(ref)}`,
  );

  const content = Buffer.from(response.content, 'base64').toString('utf8');
  return {
    sha: response.sha,
    document: JSON.parse(content),
  };
}

async function updateRemoteFile({ branch, content, sha, message }) {
  return githubFetch(`/contents/${encodePath(config.flagsFilePath)}`, {
    method: 'PUT',
    body: JSON.stringify({
      branch,
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha,
    }),
  });
}

async function getBranch(branchName) {
  try {
    return await githubFetch(`/git/ref/heads/${branchName}`);
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function getOpenPullRequest() {
  const response = await githubFetch(
    `/pulls?state=open&head=${encodeURIComponent(
      `${config.githubOwner}:${config.githubWorkBranch}`,
    )}&base=${encodeURIComponent(config.githubBaseBranch)}`,
  );

  const pullRequest = Array.isArray(response) ? response[0] : null;
  if (!pullRequest) {
    return null;
  }

  return getPullRequestByNumber(pullRequest.number);
}

async function getPullRequestByNumber(number) {
  const pullRequest = await waitForPullRequestDetails(number);
  return toPullRequestSummary(pullRequest);
}

async function waitForPullRequestDetails(number) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pullRequest = await githubFetch(`/pulls/${number}`);
    if (pullRequest.mergeable !== null || attempt === 3) {
      return pullRequest;
    }
    await sleep(1000);
  }

  throw new Error(`Unable to load pull request #${number}`);
}

async function createPullRequest() {
  const response = await githubFetch('/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: config.prTitle,
      head: config.githubWorkBranch,
      base: config.githubBaseBranch,
      body: config.prBody,
    }),
  });

  return toPullRequestSummary(response);
}

async function mergePullRequest(number) {
  try {
    return await githubFetch(`/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({
        merge_method: 'merge',
      }),
    });
  } catch (error) {
    throw new Error(`Failed to merge PR #${number}: ${error.message}`);
  }
}

function toPullRequestSummary(pullRequest) {
  return {
    number: pullRequest.number,
    url: pullRequest.html_url,
    title: pullRequest.title,
    state: pullRequest.state,
    mergeable: pullRequest.mergeable,
    mergeableState: pullRequest.mergeable_state || 'unknown',
  };
}

function assertGitHubToken() {
  if (!config.githubToken) {
    throw new Error('GITHUB_TOKEN must be configured for GitHub operations');
  }
}

async function deployFlagsDocument(serializedDocument, restartTimestamp) {
  await kubePatch(
    `/api/v1/namespaces/${encodeURIComponent(config.clusterNamespace)}/configmaps/${encodeURIComponent(
      config.flagdConfigMapName,
    )}`,
    {
      data: {
        'demo.flagd.json': serializedDocument,
      },
    },
  );

  const patchedDeployment = await kubePatch(
    `/apis/apps/v1/namespaces/${encodeURIComponent(config.clusterNamespace)}/deployments/${encodeURIComponent(
      config.flagdDeploymentName,
    )}`,
    buildRestartPatch(restartTimestamp),
  );

  const rolloutStatus = await waitForDeploymentRollout(
    patchedDeployment.metadata.generation,
    restartTimestamp,
  );

  return {
    configMapUpdated: true,
    flagdRestarted: true,
    rolloutStatus,
  };
}

async function waitForDeploymentRollout(targetGeneration, restartTimestamp) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < config.rolloutTimeoutMs) {
    const deployment = await kubeGet(
      `/apis/apps/v1/namespaces/${encodeURIComponent(config.clusterNamespace)}/deployments/${encodeURIComponent(
        config.flagdDeploymentName,
      )}`,
    );

    const annotations =
      (((deployment || {}).spec || {}).template || {}).metadata?.annotations || {};
    const observedRestart = annotations['astroshop.demo/restartedAt'];

    if (
      observedRestart === restartTimestamp &&
      deployment.metadata.generation >= targetGeneration &&
      hasDeploymentRolledOut(deployment)
    ) {
      return {
        ready: true,
        observedGeneration: deployment.status.observedGeneration,
        generation: deployment.metadata.generation,
        availableReplicas: deployment.status.availableReplicas || 0,
        updatedReplicas: deployment.status.updatedReplicas || 0,
      };
    }

    await sleep(2000);
  }

  throw new Error(`Timed out waiting for deployment ${config.flagdDeploymentName} to roll out`);
}

async function kubeGet(pathname) {
  return kubeRequest(pathname, { method: 'GET' });
}

async function kubePatch(pathname, body) {
  return kubeRequest(pathname, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/merge-patch+json',
    },
    body: JSON.stringify(body),
  });
}

async function kubeRequest(pathname, options = {}) {
  const tokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  const caPath = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

  if (!fs.existsSync(tokenPath) || !fs.existsSync(caPath)) {
    throw new Error('Kubernetes service account credentials are not available');
  }

  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const ca = fs.readFileSync(caPath);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  const response = await requestJson({
    hostname: 'kubernetes.default.svc',
    port: 443,
    method: options.method || 'GET',
    path: pathname,
    headers,
    ca,
    body: options.body,
  });

  return response;
}

async function githubFetch(pathname, options = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'astroshop-flag-admin',
    ...(options.headers || {}),
  };

  if (config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }

  return requestJson({
    hostname: 'api.github.com',
    port: 443,
    method: options.method || 'GET',
    path: `/repos/${config.githubOwner}/${config.githubRepo}${pathname}`,
    headers,
    body: options.body,
  });
}

function requestJson(options) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: options.hostname,
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
        ca: options.ca,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const data = text ? JSON.parse(text) : null;
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(data);
            return;
          }

          const error = new Error(
            (data && data.message) || `Request failed with status ${response.statusCode}`,
          );
          error.statusCode = response.statusCode;
          reject(error);
        });
      },
    );

    request.on('error', reject);
    if (options.body) {
      request.write(options.body);
    }
    request.end();
  });
}

function encodePath(filePath) {
  return filePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendText(response, statusCode, payload, contentType) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', contentType);
  response.end(payload);
}
