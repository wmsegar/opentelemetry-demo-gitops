'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const inputPath = path.join(repoRoot, 'dynatrace.local.env');
const outputPath = path.join(repoRoot, 'kustomize', 'base', 'otel-collector-dt-credentials.env');

const envVars = fs.existsSync(inputPath) ? parseEnvFile(fs.readFileSync(inputPath, 'utf8')) : {};
const lines = [];

appendIfPresent(lines, 'DT_ENDPOINT', envVars.ASTROSHOP_OTLP_ENDPOINT);
appendIfPresent(lines, 'DT_API_TOKEN', envVars.ASTROSHOP_OTLP_TOKEN);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${lines.join('\n')}${lines.length ? '\n' : ''}`, 'utf8');

if (lines.length === 0) {
  console.warn(
    'render-dynatrace-secrets-env: no Astroshop OTLP values found in dynatrace.local.env',
  );
}

function appendIfPresent(linesList, key, value) {
  if (value === undefined || value === null || value === '') {
    return;
  }
  linesList.push(`${key}=${String(value)}`);
}

function parseEnvFile(text) {
  const result = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    result[key] = stripWrappingQuotes(value);
  }

  return result;
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
