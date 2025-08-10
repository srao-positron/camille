# Browser Automation with Camille

Camille includes browser automation capabilities that allow Claude to control web browsers for tasks like testing, web scraping, and automation.

## Setup

Browser automation support is installed automatically when you install Camille. During `npm install`, Playwright's Chromium browser is downloaded (~200MB).

If installation was skipped or failed, you can install it manually:

```bash
npx playwright install chromium
```

## Requirements

1. **Supastate Account**: Browser automation requires a Supastate account for command coordination
2. **API Key**: Generate an API key in Supastate dashboard
3. **Disk Space**: ~200MB for Chromium browser

## How It Works

1. Camille runs a browser service that connects to Supastate via Realtime
2. Claude sends browser commands through Supastate API
3. Camille executes the commands using Playwright
4. Screenshots and DOM snapshots are uploaded to Supabase Storage
5. Results are sent back to Claude for analysis

## Installation

During Camille installation (`npm install`), Playwright browsers are automatically downloaded. This adds about 200MB to the installation size but ensures browser automation works immediately without runtime delays.

## Configuration

Browser automation is only active when Supastate is configured:

```bash
# Login to Supastate
camille supastate login

# Check status
camille supastate status
```

## Security

- Browser runs in headless mode with sandbox disabled
- No access to local files or system resources
- URL restrictions can be configured (coming soon)
- All commands are logged and audited

## Troubleshooting

### "Executable doesn't exist" Error
Run: `npx playwright install chromium`

### "No active browser machines" Error
Ensure Camille is running with Supastate enabled

### Connection Issues
Check your Supastate API key and network connectivity

## Privacy

- Browser automation only activates when explicitly used
- No browsing data is collected unless requested
- Screenshots/DOM are stored in your private Supabase Storage
- You control all data retention