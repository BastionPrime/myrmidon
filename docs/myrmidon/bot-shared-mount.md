# Shared Mount Feature

## Overview
The shared mount feature enables bots to access a common directory with controlled read/write access. This replaces the previous system where each bot had its own copy of shared data using hard links, which prevented files created by one bot from being visible to others.

## Configuration

### Instance-Level Settings
The shared mount feature is configured at the instance level through the instance settings. The following options are available:

- **enabled**: Whether the shared mount feature is enabled for this instance
- **hostPath**: The host path for the shared directory (defaults to `MYRMIDON_BOT_VOLUME_ROOT/shared`)
- **writable**: Whether bots can write to the shared directory
- **allowedBots**: Allowlist of bot IDs that can access the shared directory

### Bot-Level Access Control
Individual bots can be granted access to the shared directory through the bot configuration. Access is granted based on the instance settings and the bot's ID being in the allowlist.

## Usage
When the shared mount feature is enabled and a bot has access, a shared directory will be mounted at `/shared` in the bot's container. Files placed in this directory by one bot will be visible to other bots that have access to the shared directory.

## Migration
When the feature is first enabled, existing hardlink copies from bots will be migrated to the shared directory to preserve data.