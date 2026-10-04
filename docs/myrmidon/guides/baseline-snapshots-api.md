# Baseline Snapshots API Guide

This guide describes the API endpoints for creating and managing baseline metric snapshots. These snapshots allow you to capture baseline metrics for a specific time window and use them as reference points for comparison with pilot measurements.

## Overview

The Baseline Snapshots API provides endpoints for:

- Creating snapshots of baseline metrics for arbitrary time windows
- Labeling snapshots for identification
- Pinning snapshots as reference points for pilots
- Retrieving lists of snapshots
- Fetching individual snapshots by ID

## API Endpoints

### POST /api/myrmidon/companies/:companyId/baseline/snapshots

Creates a new baseline metric snapshot for the specified company.

#### Request

**Headers:**
- `Authorization: Bearer <board_token>` (Required: Board/admin access only)

**Body:**
```json
{
  "from": "2026-09-19T08:28:00.000Z",
  "to": "2026-10-03T08:28:00.000Z",
  "label": "Q3 2026 Baseline",
  "pinned": true
}
```

**Parameters:**
- `from` (string): Start time in ISO 8601 format
- `to` (string): End time in ISO 8601 format
- `label` (string): Human-readable label for the snapshot
- `pinned` (boolean): Whether this snapshot should be pinned as a reference point

#### Response

**Success (201 Created):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
  "companyId": "company-uuid",
  "windowFrom": "2026-09-19T08:28:00.000Z",
  "windowTo": "2026-10-03T08:28:00.000Z",
  "generatedAt": "2026-10-04T10:00:00.000Z",
  "label": "Q3 2026 Baseline",
  "pinned": true,
  "payload": {
    "window": { "from": "2026-09-19T08:28:00.000Z", "to": "2026-10-03T08:28:00.000Z" },
    "source": { "statusLog": "activity_log", "costs": "litellm_cost_events" },
    "byProject": [],
    "byRole": []
  }
}
```

`payload` is the full metrics answer computed by the same
`computeBaselineMetrics` the `GET …/baseline/metrics` endpoint uses — the same
shape, frozen at creation time.

**Errors:**
- `403 Forbidden`: Agent token used (admin access required)
- `400 Bad Request`: Invalid parameters (missing or unparseable `from`/`to`, or `from` after `to`)

### GET /api/myrmidon/companies/:companyId/baseline/snapshots

Retrieves a list of all baseline snapshots for the specified company.

#### Request

**Headers:**
- `Authorization: Bearer ***

#### Response

**Success (200 OK):**
```json
[
  {
    "id": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
    "companyId": "company-uuid",
    "windowFrom": "2026-09-19T08:28:00.000Z",
    "windowTo": "2026-10-03T08:28:00.000Z",
    "generatedAt": "2026-10-04T10:00:00.000Z",
    "label": "Q3 2026 Baseline",
    "pinned": true,
    "payload": { }
  }
]
```

### GET /api/myrmidon/companies/:companyId/baseline/snapshots/:id

Retrieves a specific baseline snapshot by ID.

#### Request

**Headers:**
- `Authorization: Bearer ***
- `id`: UUID of the snapshot to retrieve

#### Response

**Success (200 OK):**
```json
{
  "id": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
  "companyId": "company-uuid",
  "windowFrom": "2026-09-19T08:28:00.000Z",
  "windowTo": "2026-10-03T08:28:00.000Z",
  "generatedAt": "2026-10-04T10:00:00.000Z",
  "label": "Q3 2026 Baseline",
  "pinned": true,
  "payload": { }
}
```

**Errors:**
- `404 Not Found`: Snapshot with given ID does not exist for this company

## Pinning Logic

The API enforces the following pinning logic:
- Only one snapshot can be pinned per company at any given time
- When a new snapshot is created with `pinned: true`, any previously pinned snapshot for that company is automatically unpinned
- Multiple snapshots with `pinned: false` are allowed

## Authentication and Authorization

- Creating snapshots requires board/admin access (board tokens)
- Reading snapshots is available to any valid token holder
- Agent tokens are rejected for snapshot creation with a 403 Forbidden response

## Example Usage

Creating a snapshot for the period between September 19, 2026 and October 3, 2026:

```bash
curl -X POST \
  https://your-domain.com/api/myrmidon/companies/your-company-id/baseline/snapshots \
  -H 'Authorization: Bearer your-board-token' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "2026-09-19T08:28:00.000Z",
    "to": "2026-10-03T08:28:00.000Z",
    "label": "Pre-pilot Baseline",
    "pinned": true
  }'
```