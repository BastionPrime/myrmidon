# AUTONOMY-MATRIX: Holding Actions for Approval

This document describes the functionality that enables the autonomy matrix to hold actions requiring approval, creating approval cards for human review before execution.

## Overview

Starting with version 1.6.2, the autonomy matrix system supports holding actions that require approval. When an agent attempts an action that has the `approval_required` verdict in the autonomy matrix, instead of executing immediately, the system:

1. Creates an approval card (using the existing tool action request mechanism)
2. Returns a 202 response indicating the action is held
3. Stores the action details for later execution
4. Waits for human approval before executing the original action

## Action Classes

The system supports approval requirements for the following action classes:

- `pause_wake_agents`: Pausing, resuming, or waking agents
- Other action classes can be added as needed

## Implementation Details

### Gate Function

The `holdOrAssert` function in the autonomy gate handles the approval workflow:

```typescript
async function holdOrAssert(
  req: Request, 
  actionClass: AutonomyActionClass, 
  descriptor: {
    route: string;
    method: string;
    params?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }
): Promise<{ verdict: AutonomyVerdict; held?: boolean; approvalId?: string }>
```

### API Changes

The following API endpoints now support the autonomy matrix approval workflow:

- `POST /agents/:id/pause`
- `POST /agents/:id/resume` 
- `POST /agents/:id/wakeup`

When these endpoints encounter an action that requires approval, they return a `202 Accepted` response with the following body:

```json
{
  "held": true,
  "approvalId": "unique-approval-id"
}
```

### Execution After Approval

Once an action is approved, the system stores the original action details and executes the action on behalf of the original actor. The execution happens exactly once, ensuring idempotency.

## Configuration

The autonomy matrix can be configured through the standard matrix editing interface. Set the verdict for any action class to `approval_required` to enable the approval workflow for that action type.