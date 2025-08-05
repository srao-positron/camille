# Supastate Token Refresh Guide

## Overview

This guide explains how to use the new token refresh functionality in Camille CLI to manage your Supastate authentication tokens.

## New Commands

### Manual Token Refresh

You can now manually refresh your Supastate authentication token using either of these commands:

```bash
camille supastate refresh-token
camille supastate tokenrefresh
```

### What the Command Does

1. **Shows Current Token Status**
   - Displays your email and user ID
   - Shows when the current token expires
   - Indicates if the token is already expired

2. **Refreshes the Token**
   - Exchanges your refresh token for a new access token
   - Updates the stored tokens in your local config
   - Shows the new expiration time

3. **Verifies the New Token**
   - Makes a test API call to ensure the new token works
   - Confirms successful authentication

## Automatic Token Refresh

The Camille storage provider now includes improved automatic token refresh:

1. **Dual Refresh Strategy**
   - First tries the Supastate API refresh endpoint (handles cookies properly)
   - Falls back to direct Supabase auth refresh if needed

2. **Token Expiry Detection**
   - Automatically detects when tokens are about to expire (1 minute before)
   - Refreshes tokens transparently during normal operations

3. **Better Error Handling**
   - Provides specific error messages for expired vs invalid tokens
   - Guides users to re-login when refresh tokens are invalid

## Common Scenarios

### Token Expired During Long Session

If you've been away and your token expired:
```bash
camille supastate refresh-token
```

### Check Token Status

To see when your token expires:
```bash
camille supastate refresh-token
```
This shows the status without necessarily refreshing if the token is still valid.

### After Network Issues

If you suspect authentication issues after network problems:
```bash
camille supastate refresh-token
```

### Token Refresh Failed

If token refresh fails, you'll see one of these messages:
- "Refresh token has expired. Please login again."
- "Invalid refresh token. Please login again."

In these cases, re-authenticate:
```bash
camille supastate login
```

## Technical Details

### Token Storage

Tokens are stored in `~/.camille/config.json`:
```json
{
  "supastate": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1234567890,
    "userId": "...",
    "email": "user@example.com"
  }
}
```

### API Endpoints

- **Supastate Refresh**: `POST /api/auth/refresh`
  - Handles cookies and session management
  - Returns new access and refresh tokens

- **Token Verification**: `GET /api/memories/stats`
  - Used to verify the new token works

### Security

- Refresh tokens are stored locally in your home directory
- Access tokens expire after 1 hour by default
- Refresh tokens expire after 30 days
- All tokens are transmitted over HTTPS

## Troubleshooting

### "No authentication tokens found"
- Run `camille supastate login` to authenticate first

### "Supastate not enabled"
- Run `camille supastate login` to set up integration

### "Failed to refresh token"
- Check your internet connection
- Ensure Supastate service is accessible
- Try logging in again if the problem persists

### Token refreshed but verification failed
- The token was refreshed but may have permission issues
- Try using the token for normal operations
- Contact support if issues persist

## Best Practices

1. **Regular Usage**: Tokens refresh automatically during normal use
2. **Long Breaks**: Manually refresh after extended periods away
3. **Security**: Never share your refresh token
4. **Monitoring**: Check token status periodically with the refresh command

## Integration with Other Tools

The improved token refresh mechanism ensures:
- Seamless memory syncing to Supastate
- Uninterrupted code analysis uploads
- Consistent authentication across all Camille features