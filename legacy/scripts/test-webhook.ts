#!/usr/bin/env ts-node

import { config } from '../src/config';
import { WebhookService } from '../src/services/webhook';

async function testWebhook() {
  console.log('🔍 Testing Webhook Configuration...\n');

  // Check webhook configuration
  const isWebhookMode = !!(config.telegram.webhookUrl && config.telegram.webhookPort);

  if (!isWebhookMode) {
    console.log('❌ Webhook mode not configured');
    console.log('   Set WEBHOOK_URL and PORT in your .env file');
    return;
  }

  console.log('✅ Webhook configuration found:');
  console.log(`   URL: ${config.telegram.webhookUrl}`);
  console.log(`   Port: ${config.telegram.webhookPort}`);
  console.log(`   Secret: ${config.telegram.webhookSecret ? 'Configured' : 'Not set'}`);

  // Test webhook server startup
  console.log('\n🚀 Starting webhook server...');

  const webhookService = new WebhookService();

  try {
    await webhookService.start();
    console.log('✅ Webhook server started successfully');

    // Test health endpoint
    console.log('\n🏥 Testing health endpoint...');

    const fetch = (await import('node-fetch')).default;
    const healthUrl = `http://localhost:${config.telegram.webhookPort}/health`;

    try {
      const response = await fetch(healthUrl);
      const data = await response.json();

      if (response.ok) {
        console.log('✅ Health endpoint working');
        console.log(`   Response: ${JSON.stringify(data)}`);
      } else {
        console.log('❌ Health endpoint returned error');
        console.log(`   Status: ${response.status}`);
      }
    } catch (fetchError) {
      console.log('❌ Could not reach health endpoint');
      console.log(`   Error: ${fetchError}`);
    }

    console.log('\n📋 Next steps:');
    console.log('1. Ensure your webhook URL is publicly accessible via HTTPS');
    console.log('2. Test external access: curl https://your-domain.com/health');
    console.log('3. Start your bot with webhook mode enabled');

    await webhookService.stop();
    console.log('\n✅ Webhook test completed');

  } catch (error) {
    console.error('❌ Failed to start webhook server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down webhook test...');
  process.exit(0);
});

if (require.main === module) {
  testWebhook().catch((error) => {
    console.error('Fatal error during webhook test:', error);
    process.exit(1);
  });
}
