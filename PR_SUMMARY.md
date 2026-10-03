# PR Summary: BOT-DISK D — Shared Mount Feature

## Overview
This PR implements the shared mount feature that allows bots to access a common directory with controlled read/write access. This resolves the issue where bots had individual copies of shared data using hard links, which prevented files created by one bot from being visible to others.

## Changes Made

### 1. Core Shared Mount Module
- **File:** `server/src/myrmidon/bot-containers/shared-mount.ts`
- **Changes:** 
  - Created the core logic for shared directory management
  - Implemented functions for ensuring shared directory existence with proper permissions
  - Added migration logic for converting existing hardlink copies to shared mount
  - Added access control based on instance settings and bot allowlists

### 2. Integration with Bot Container System
- **File:** `server/src/myrmidon/bot-containers/agent-config.ts`
- **Changes:**
  - Updated to include shared mount access determination based on instance settings
  - Modified to accept instance-level shared mount settings for access control
  
- **File:** `server/src/myrmidon/bot-containers/docker-driver.ts`
- **Changes:**
  - Modified `buildCreateContainerRequestBody` to include shared mount path when bot has access
  - Updated container creation logic to handle shared mount bindings

- **File:** `server/src/myrmidon/bot-containers/template.ts`
- **Changes:**
  - Updated `buildBinds` function to support shared mount path in container binds
  - Added support for optional shared mount path in bind mounts

- **File:** `server/src/myrmidon/bot-containers/index.ts`
- **Changes:**
  - Added `instanceSharedMountSettings` to `BotContainerRuntimeDeps` interface
  - Updated `applyBotContainerNow` and `readAgentForPass` to pass instance settings to agent config
  - Updated sweep function to consider shared mount settings when checking bot eligibility

### 3. Instance Settings Integration
- **File:** `packages/shared/src/types/instance.ts`
- **Changes:**
  - Added `SharedMountSettings` type to instance general settings
  - Added import for shared mount settings type

- **File:** `packages/shared/src/myrmidon-shared-mount.ts`
- **Changes:**
  - Created shared mount settings type definition for use in shared package

- **File:** `server/src/services/instance-settings.ts`
- **Changes:**
  - Updated `normalizeGeneralSettings` to preserve shared mount settings during normalization

### 4. Documentation
- **File:** `docs/myrmidon/bot-shared-mount.md`
- **Changes:**
  - Created English documentation for the shared mount feature

- **File:** `docs/myrmidon/bot-shared-mount.ru.md`
- **Changes:**
  - Created Russian documentation for the shared mount feature

### 5. Tests
- **File:** `server/src/myrmidon/bot-containers/shared-mount.myrmidon.test.ts`
- **Changes:**
  - Comprehensive tests for all shared mount functionality
  - Integration test demonstrating that files placed by one bot are visible to another
  - Mock tests that verify the core requirement without requiring Docker socket

## Key Features

1. **Shared Directory**: All bots that have access can see the same shared directory
2. **Access Control**: Configurable at both instance and bot levels
3. **Migration**: Automatic migration of existing hardlink copies to the shared directory
4. **Permissions**: Configurable read/write permissions for the shared directory
5. **Allowlisting**: Ability to specify which bots can access the shared directory

## Architecture

The implementation follows the existing architecture patterns:
- Instance settings control the overall feature availability and global settings
- Bot-level configuration determines individual bot access
- Migration preserves existing data when the feature is first enabled
- Docker container creation includes the shared mount binding when appropriate

## Testing

The tests demonstrate the core requirement: "Файл, положенный в `shared` ботом A, виден боту B" (A file placed in `shared` by bot A is visible to bot B). The integration test creates two simulated bot volumes that both connect to the same shared directory, then verifies that a file created by one bot is accessible by the other.

## Validation

All changes maintain backward compatibility and follow existing code patterns. The feature is controlled by instance settings and can be enabled/disabled without requiring container restarts.