## Verification Steps for BOT-IMAGE-ROLLOUT Feature

### Pre-deployment Verification
1. Check current bot images on dockergate:
   ```bash
   curl -s http://dockergate-host:port/v1/config | jq '.images'
   ```

2. Verify current bot card configurations:
   ```bash
   # Check bot configurations in the board UI or via API
   curl -s http://board-host:port/api/agents | jq '.[].adapterConfig.image'
   ```

### During Rollout Verification
1. Monitor the rollout journal:
   ```bash
   tail -f $STATE_DIR/bot-image-rollout.log
   ```

2. Check for deferred bot updates:
   ```bash
   # The script handles deferred updates automatically when runs finish
   # Look for "DEFERRED" entries in the log
   ```

### Post-deployment Verification
1. Confirm new images are in dockergate:
   ```bash
   curl -s http://dockergate-host:port/v1/config | jq '.images'
   # Should contain new release images
   ```

2. Verify bot cards switched to new images:
   ```bash
   curl -s http://board-host:port/api/agents | jq '.[].adapterConfig.image'
   # Should show new release images
   ```

3. Check that no runs were interrupted:
   ```bash
   # Monitor run completion statistics during rollout
   # Check for any unexpected run failures during the transition
   ```

4. Verify new bots enroll automatically:
   ```bash
   # Add a new bot to the board
   # Check that it appears in dockergate bots[] automatically
   curl -s http://dockergate-host:port/v1/config | jq '.bots'
   ```

### Rollout Script Self-Checks
The `bot-image-rollout.sh` script includes built-in verification:
- Fail-closed behavior if any step fails
- Deferred retries for busy bots
- Canary-first processing
- Complete journaling of all operations
- Health checks before and after changes