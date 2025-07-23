# OAuth Login Debug Instructions

## Environment Variables

If using a custom Supabase instance (not service.supastate.ai), set these environment variables:

```bash
export SUPABASE_URL=https://your-supabase-url.supabase.co
export SUPABASE_ANON_KEY=your-anon-key
```

## Debug Flow

1. Run `camille supastate login` and watch for these debug messages:
   - `[DEBUG] Using Supabase URL: ...`
   - `[DEBUG] Redirect URL will be: ...`
   - `[DEBUG] Generated auth URL: ...`
   - `[DEBUG] Received POST to /cli-callback` (if successful)

2. In the browser console on the callback page, look for:
   - `[CLI Auth Debug] Attempting to send API key to CLI at ...`
   - `[CLI Auth Debug] Response from CLI: ...`

3. Check Supastate logs (if deployed) for:
   - `[CLI Auth Debug] Received callback with: ...`
   - `[CLI Auth Debug] Successfully exchanged code for session`
   - `[CLI Auth Debug] API key created successfully`

## Common Issues

1. **Wrong Supabase URL**: Make sure SUPABASE_URL is set correctly
2. **Redirect URL not allowed**: The default `/auth/callback` should already be allowed
3. **Port conflict**: CLI uses port 8899, make sure it's available
4. **CORS issues**: The route handler includes CORS headers, check browser console
5. **Supabase ignoring redirect_to**: This is expected - we handle CLI auth via query params

## Testing Locally

To test with local Supastate:
```bash
camille supastate login --url http://localhost:3000
```