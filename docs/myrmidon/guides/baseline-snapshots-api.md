# Baseline Snapshots API

The Baseline Snapshots API allows you to create and manage frozen metric snapshots for comparison purposes. These snapshots capture baseline metrics for a specific time window and can be labeled and pinned for easy reference.

## Endpoints

### POST /api/myrmidon/companies/:companyId/baseline/snapshots

Creates a new baseline metric snapshot for the specified company.

#### Authentication
- Requires board user authentication (agent API keys will receive 403 Forbidden)
- Company access validation required

#### Request Body
```json
{
  "from": "2023-01-01T00:00:00Z",
  "to": "2023-01-31T23:59:59Z",
  "label": "january-2023-baseline",
  "pinned": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| from | string (ISO 8601) | Yes | Start date of the time window |
| to | string (ISO 8601) | Yes | End date of the time window |
| label | string | No | Optional label for the snapshot |
| pinned | boolean | No | Whether this snapshot is pinned (default: false) |

#### Response
- Status: `201 Created`
- Content-Type: `application/json`

```json
{
  "id": "uuid-string",
  "companyId": "uuid-string",
  "windowFrom": "2023-01-01T00:00:00.000Z",
  "windowTo": "2023-01-31T23:59:59.000Z",
  "generatedAt": "2023-02-01T10:00:00.000Z",
  "label": "january-2023-baseline",
  "pinned": true
}
```

#### Behavior
- Computes baseline metrics for the specified time window using the same logic as the metrics endpoint
- Saves the computed metrics as a frozen snapshot in the database
- If `pinned` is true, automatically unpins any previously pinned snapshot for the company
- Only one snapshot can be pinned per company at any given time

---

### GET /api/myrmidon/companies/:companyId/baseline/snapshots

Retrieves all baseline snapshots for the specified company.

#### Authentication
- Company access validation required

#### Response
- Status: `200 OK`
- Content-Type: `application/json`

```json
[
  {
    "id": "uuid-string",
    "companyId": "uuid-string",
    "windowFrom": "2023-01-01T00:00:00.000Z",
    "windowTo": "2023-01-31T23:59:59.000Z",
    "generatedAt": "2023-02-01T10:00:00.000Z",
    "label": "january-2023-baseline",
    "pinned": true
  },
  {
    "id": "uuid-string",
    "companyId": "uuid-string",
    "windowFrom": "2023-02-01T00:00:00.000Z",
    "windowTo": "2023-02-28T23:59:59.000Z",
    "generatedAt": "2023-03-01T10:00:00.000Z",
    "label": "february-2023-baseline",
    "pinned": false
  }
]
```

---

### GET /api/myrmidon/companies/:companyId/baseline/snapshots/:snapshotId

Retrieves a specific baseline snapshot by ID.

#### Authentication
- Company access validation required

#### Parameters
- `snapshotId`: UUID of the specific snapshot to retrieve

#### Response
- Status: `200 OK`
- Content-Type: `application/json`

```json
{
  "id": "uuid-string",
  "companyId": "uuid-string",
  "windowFrom": "2023-01-01T00:00:00.000Z",
  "windowTo": "2023-01-31T23:59:59.000Z",
  "generatedAt": "2023-02-01T10:00:00.000Z",
  "label": "january-2023-baseline",
  "pinned": true,
  "payload": {
    // Full baseline metrics payload as returned by the metrics endpoint
    "window": {
      "from": "2023-01-01T00:00:00.000Z",
      "to": "2023-01-31T23:59:59.000Z"
    },
    "generatedAt": "2023-02-01T10:00:00.000Z",
    "source": {
      "statusLog": "activity_log",
      "costs": "litellm_cost_events"
    },
    "byProject": [...],
    "byRole": [...]
  }
}
```

## Use Cases

### Creating a Baseline Before Changes
Create a snapshot before implementing changes to compare metrics afterward:

```bash
curl -X POST \
  -H "Authorization: Bearer BOARD_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "2023-01-01T00:00:00Z",
    "to": "2023-01-31T23:59:59Z",
    "label": "pre-change-baseline",
    "pinned": true
  }' \
  "http://localhost:3100/api/myrmidon/companies/COMPANY_ID/baseline/snapshots"
```

### Comparing Metrics Over Time
Retrieve snapshots to compare metrics from different periods:

```bash
curl -H "Authorization: Bearer BOARD_TOKEN" \
  "http://localhost:3100/api/myrmidon/companies/COMPANY_ID/baseline/snapshots"
```

## Implementation Details

- Snapshots are stored in the `baseline_metric_snapshots` table
- Each snapshot contains the complete metrics payload for the specified time window
- The `pinned` field allows marking a specific snapshot as the reference point
- Only board users can create snapshots (agent API keys receive 403 Forbidden)
- When a new snapshot is pinned, any previously pinned snapshot for the same company is automatically unpinned