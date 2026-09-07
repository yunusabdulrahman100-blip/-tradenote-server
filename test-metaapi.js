require('dotenv').config();
const MetaApi = require('metaapi.cloud-sdk').default;

const token = process.env.METAAPI_TOKEN;
const accountId = 'c1cae798-3f8b-4dbd-9cf8-d10543ff9259'; // your Exness-MT5Real27 account

async function main() {
  const api = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);

  console.log('Account state:', account.state);
  console.log('Connection status:', account.connectionStatus);

  const connection = account.getRPCConnection();
  await connection.connect();
  await connection.waitSynchronized();

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 30 * 24 * 60 * 60 * 1000); // last 30 days

  const result = await connection.getDealsByTimeRange(startTime, endTime);
  console.log(`Found ${result.deals.length} deals in the last 30 days:`);
  console.log(JSON.stringify(result.deals, null, 2));

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});