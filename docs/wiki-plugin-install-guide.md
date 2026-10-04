# LLM Wiki Plugin Installation and Upgrade Guide

## Overview
The LLM Wiki plugin (`@paperclipai/plugin-llm-wiki`) provides local-file LLM Wiki functionality for source ingestion, wiki browsing, query, lint, and maintenance workflows.

## Installation

### Prerequisites
- Paperclip instance running version 1.4 or later
- Operator access to the Paperclip instance
- Network access to GitHub Package Registry (for plugin installation)

### Automatic Installation (Recommended)
The plugin is installed automatically as part of the standard Myrmidon deployment when using version 1.6 or later.

### Manual Installation
1. Navigate to the Plugins section in your Paperclip instance
2. Click "Install Plugin" 
3. Search for `@paperclipai/plugin-llm-wiki`
4. Click "Install" and follow the configuration prompts

## Configuration
After installation:

1. Configure the "Wiki root" folder in the plugin settings:
   - This is a local folder that will store raw sources, wiki pages, and related files
   - The folder must contain required files: `AGENTS.md`, `IDEA.md`, `wiki/index.md`, and `wiki/log.md`
   - Required directories will be created automatically if they don't exist

2. Set up the local folder with initial content:
   - Create the directory structure: `raw/`, `wiki/`, `wiki/sources/`, `wiki/projects/`, `wiki/entities/`, `wiki/concepts/`, `wiki/synthesis/`
   - Add initial files: `AGENTS.md`, `IDEA.md`, `wiki/index.md`, `wiki/log.md`

## Upgrade Process

### Automated Upgrades
Starting with version 1.6, the plugin will be upgraded automatically when you upgrade your Myrmidon instance to a newer version that includes a newer version of the LLM Wiki plugin.

### Manual Upgrades
1. Go to the Plugins section in your Paperclip instance
2. Find the LLM Wiki plugin in the installed plugins list
3. Click "Upgrade" if a newer version is available
4. Restart the plugin service if prompted

## Version History
- v0.1.0: Initial release with full wiki functionality including ingestion, querying, linting, and maintenance workflows

## Troubleshooting
- If the plugin fails to start, check that the configured wiki root folder exists and has proper read/write permissions
- For issues with wiki operations, verify that the required initial files are present in the wiki root
- Check the plugin logs for detailed error information

## Support
For support issues, please contact the Paperclip team or refer to the documentation at `packages/plugins/plugin-llm-wiki/README.md`.