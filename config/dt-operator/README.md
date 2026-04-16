# Dynatrace operator

You can deploy Dynatrace operator following official [guide](https://docs.dynatrace.com/docs/ingest-from/setup-on-k8s/deployment/full-stack-observability) or by running

```bash
./deploy
```

Create a local ignored `dynatrace.local.env` file at the repo root before deployment.

- `DT_OPERATOR_SECRET_NAME` - the secret name referenced by the `DynaKube` resource, e.g. `astroshop`
- `DT_OPERATOR_API_URL` - url of the tenant including `/api`, e.g. **https://wkf10640.live.dynatrace.com/api**
- `DT_OPERATOR_API_TOKEN` - access token using the `Kubernetes: Dynatrace Operator` template
- `DT_OPERATOR_DATA_INGEST_TOKEN` - access token using the `Kubernetes: Data Ingest` template
