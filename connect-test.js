async function main() {
  const res = await fetch('http://localhost:5000/api/broker-sync/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: '79f50ab6-5838-4725-ab6f-4363c8b92c54',
      broker: 'Exness',
      platform: 'mt5',
      login: '296100568',
      server: 'Exness-MT5Real27',
      password: '@#RIchen0593'
    })
  });
  const data = await res.json();
  console.log(data);
}

main();
