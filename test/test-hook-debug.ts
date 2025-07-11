// Test with debugging enabled
const SECRET_KEY = 'production_secret_key_12345';
const DATABASE_URL = 'postgres://admin:password123@prod.db.com/mydb';
const ANOTHER_SECRET = 'api_key_production';

// Add a function to trigger reindexing
export function processSecrets() {
  console.log('Processing secrets...');
  return {
    key: SECRET_KEY,
    db: DATABASE_URL,
    api: ANOTHER_SECRET
  };
}