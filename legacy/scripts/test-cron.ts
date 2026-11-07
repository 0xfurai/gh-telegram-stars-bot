#!/usr/bin/env ts-node

import { config } from '../src/config';

async function testExternalCron() {
  console.log('🔍 Testing External Cron Configuration...\n');

  // Check external cron configuration
  if (!config.cron.externalEnabled) {
    console.log('❌ External cron mode not enabled');
    console.log('   Set EXTERNAL_CRON_ENABLED=true in your .env file');
    return;
  }

  console.log('✅ External cron configuration found:');
  console.log(`   Enabled: ${config.cron.externalEnabled}`);
  console.log(`   API Key: ${config.cron.apiKey ? 'Configured' : 'Not set (endpoint will be unprotected)'}`);
  console.log(`   Port: ${config.telegram.webhookPort}`);

  // Check if webhook port is configured
  if (!config.telegram.webhookPort) {
    console.log('❌ Webhook port not configured');
    console.log('   Set PORT in your .env file');
    return;
  }

  console.log('\n🧪 Testing external cron endpoint...');

  try {
    const fetch = (await import('node-fetch')).default;
    const endpoint = `http://localhost:${config.telegram.webhookPort}/poll`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.cron.apiKey) {
      headers['Authorization'] = `Bearer ${config.cron.apiKey}`;
    }

    console.log(`Making request to: ${endpoint}`);
    console.log(`With headers: ${JSON.stringify(headers, null, 2)}`);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
    });

    const data = await response.text();

    if (response.ok) {
      console.log('✅ External cron endpoint working');
      console.log(`   Status: ${response.status}`);
      console.log(`   Response: ${data}`);
    } else {
      console.log('❌ External cron endpoint returned error');
      console.log(`   Status: ${response.status}`);
      console.log(`   Response: ${data}`);
    }

  } catch (error) {
    console.log('❌ Could not reach external cron endpoint');
    console.log(`   Error: ${error}`);
    console.log('\n💡 Make sure your bot is running first:');
    console.log('   npm run dev');
  }

  console.log('\n📋 Usage examples:');
  console.log('# Test endpoint with curl:');
  if (config.cron.apiKey) {
    console.log(`curl -X POST http://localhost:${config.telegram.webhookPort}/poll \\`);
    console.log(`  -H "Authorization: Bearer ${config.cron.apiKey}"`);
  } else {
    console.log(`curl -X POST http://localhost:${config.telegram.webhookPort}/poll`);
  }

  console.log('\n# GitHub Actions workflow:');
  console.log('```yaml');
  console.log('name: Trigger Bot Polling');
  console.log('on:');
  console.log('  schedule:');
  console.log("    - cron: '*/30 * * * *'  # Every 30 minutes");
  console.log('jobs:');
  console.log('  trigger-polling:');
  console.log('    runs-on: ubuntu-latest');
  console.log('    steps:');
  console.log('      - name: Trigger Bot Polling');
  console.log('        run: |');
  console.log('          curl -X POST ${{ secrets.BOT_URL }}/poll \\');
  if (config.cron.apiKey) {
    console.log('            -H "Authorization: Bearer ${{ secrets.CRON_API_KEY }}"');
  }
  console.log('```');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down external cron test...');
  process.exit(0);
});

if (require.main === module) {
  testExternalCron().catch((error) => {
    console.error('Fatal error during external cron test:', error);
    process.exit(1);
  });
}
