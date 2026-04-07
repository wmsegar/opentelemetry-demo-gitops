# Component: flag-admin-ui

This component deploys a small internal admin application for toggling supported `flagd` feature flags through a GitHub-based workflow.

## Required local values

Add the following values to `kustomize/base/values.local.yaml`:

```yaml
components:
  flag-admin-ui:
    authUsername: admin
    authPassword: "change-me"
    githubToken: ghp_xxx
```

During `./deploy`, the repo generates `kustomize/components/flag-admin-ui/data.env` from those values and Kustomize creates the `flag-admin-ui-secrets` Secret automatically.

Quote `authPassword` if it contains YAML-special characters such as `#` or `:`.

Required values:

- `authUsername` - basic auth username for the admin UI
- `authPassword` - basic auth password for the admin UI
- `githubToken` - GitHub token with repo access to the target fork, including PR creation and merge permissions

## Publish behavior

The admin UI now supports two actions:

- `Save changes` creates or updates a PR on `admin/flag-toggles`
- `Publish` merges the PR into the fork's `main`, updates the live `flagd-config` ConfigMap, and restarts the `flagd` deployment in `astroshop`

The component ships a dedicated service account and namespace-scoped RBAC so the admin service can update only:

- `ConfigMap/flagd-config`
- `Deployment/flagd`
