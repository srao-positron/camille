#!/usr/bin/env node

/**
 * Test script for the new token refresh command
 * This script demonstrates how the token refresh command works
 */

const { execSync } = require('child_process');
const chalk = require('chalk');

console.log(chalk.blue('Testing Camille Supastate Token Refresh Command\n'));

try {
  // First, check the current status
  console.log(chalk.yellow('1. Checking current Supastate status:'));
  try {
    execSync('camille supastate status', { stdio: 'inherit' });
  } catch (e) {
    console.log(chalk.red('Supastate not configured or status check failed'));
  }
  
  console.log(chalk.yellow('\n2. Testing token refresh command:'));
  
  // Test the refresh-token command
  try {
    execSync('camille supastate refresh-token', { stdio: 'inherit' });
    console.log(chalk.green('\n✅ Token refresh command executed successfully!'));
  } catch (e) {
    console.log(chalk.red('\n❌ Token refresh failed. This is expected if:'));
    console.log(chalk.gray('   - You are not logged in to Supastate'));
    console.log(chalk.gray('   - Your refresh token has expired'));
    console.log(chalk.gray('   - There is a network issue'));
    console.log(chalk.gray('\nRun "camille supastate login" to authenticate first.'));
  }
  
  // Test the alias
  console.log(chalk.yellow('\n3. Testing command alias (tokenrefresh):'));
  try {
    execSync('camille supastate tokenrefresh --help', { stdio: 'inherit' });
    console.log(chalk.green('\n✅ Command alias works correctly!'));
  } catch (e) {
    console.log(chalk.red('❌ Alias test failed'));
  }
  
} catch (error) {
  console.error(chalk.red('Test script error:'), error.message);
  process.exit(1);
}

console.log(chalk.blue('\n📝 Summary:'));
console.log(chalk.gray('The new token refresh command can be used as:'));
console.log(chalk.cyan('  camille supastate refresh-token'));
console.log(chalk.cyan('  camille supastate tokenrefresh'));
console.log(chalk.gray('\nThe command will:'));
console.log(chalk.gray('  - Show current token status (expiry time)'));
console.log(chalk.gray('  - Attempt to refresh the access token'));
console.log(chalk.gray('  - Update stored tokens if successful'));
console.log(chalk.gray('  - Verify the new token is working'));