# CAP AWS S3 Monitoring

This project contains a SAP Cloud Application Programming Model (CAP) service that integrates with the SAP Object Store (AWS S3 compatible) and the SAP Job Scheduling service. The service keeps track of newly uploaded files in the configured bucket and exposes this information over OData.

## Features

- Scheduled monitoring job executed via the SAP Job Scheduling service.
- Secure callbacks using `@sap/xssec` to validate Job Scheduler JWT tokens.
- Object metadata persisted in the CAP persistence layer.
- Writes a monitoring status file back to the Object Store bucket using multipart uploads.
- Health check of the Job Scheduler endpoint using the SAP Cloud SDK HTTP client protected by a resilience circuit breaker.

## Project Structure

```
├── db
│   └── schema.cds             # Persistence model for tracked files
├── srv
│   ├── monitoring-service.cds # OData service definition
│   └── monitoring-service.js  # Service implementation and integration logic
├── .cdsrc.json                # CAP configuration and required services
└── package.json               # Dependencies and scripts
```

## Configuration

The application relies on SAP BTP service bindings. When running locally you can provide credentials via a default-env.json file or environment variables.

### Required service bindings

- **SAP Object Store**: must expose S3 compatible credentials (`access_key_id`, `secret_access_key`, `endpoint`, `bucket`).
- **SAP Job Scheduling service**: must contain the scheduler URL and the UAA client credentials.

Example `default-env.json` snippet:

```json
{
  "VCAP_SERVICES": {
    "objectstore": [
      {
        "name": "objectStore-monitoring",
        "credentials": {
          "endpoint": "https://objectstore.example.com",
          "access_key_id": "ACCESS_KEY",
          "secret_access_key": "SECRET",
          "bucket": "uploads",
          "region": "eu10"
        }
      }
    ],
    "jobscheduler": [
      {
        "name": "jobscheduler-monitoring",
        "credentials": {
          "url": "https://jobscheduler.example.com",
          "uaa": {
            "clientid": "client-id",
            "clientsecret": "client-secret",
            "url": "https://jobscheduler.auth.example.com"
          }
        }
      }
    ]
  }
}
```

You can override defaults using the following environment variables:

- `OBJECT_STORE_BUCKET`: bucket to monitor (otherwise taken from service credentials)
- `MONITORING_JOB_NAME`: custom job definition name
- `MONITORING_JOB_CRON`: cron expression for the job schedule
- `MONITORING_CALLBACK_URL`: base URL reachable by the Job Scheduler
- `MONITORING_CALLBACK_PATH`: path appended to the callback URL (defaults to `/odata/v4/MonitoringService/CheckBucket`)
- `MONITORING_STATUS_PREFIX`: folder/prefix for the generated status object in the bucket

## Running Locally

Install dependencies and start the CAP server:

```bash
npm install
npm run deploy
npm start
```

Trigger a manual bucket scan using the OData action:

```bash
curl -X POST \
  "http://localhost:4004/odata/v4/MonitoringService/CheckBucket" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Fetched metadata will be persisted in the `monitoring.TrackedFiles` entity. Use the generated OData endpoint to list stored entries:

```bash
curl "http://localhost:4004/odata/v4/MonitoringService/TrackedFiles"
```

## Notes

- The default database is SQLite for local development. Deploy to SAP HANA using the `@cap-js/hana` driver when running in SAP BTP.
- The SAP Job Scheduling client uses optimistic upsert logic. Ensure the application has the necessary scope grants to manage jobs.
- The SAP Cloud SDK `executeHttpRequest` call is wrapped by a circuit breaker, avoiding repeated calls to an unhealthy Job Scheduler endpoint.
- Runtime dependencies in `package.json` are aligned to the latest published versions (including CAP v9 and newer SAP Cloud SDK releases). Re-run `npm install` to resolve updates before deploying.
