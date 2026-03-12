# Self-Hosting PayBot Facilitator with Docker

For enterprise bots or custom network requirements, deploy your own PayBot facilitator.

## Quick Start (5 minutes)

### 1. Clone paybot-core

```bash
git clone https://github.com/RBKunnela/paybot-core.git
cd paybot-core
```

### 2. Create `.env` file

```env
# Network
X402_NETWORK=eip155:84532
RELAYER_RPC_URL=https://sepolia.base.org

# Settlement (use 'mock' for testing)
SETTLEMENT_MODE=mock
COMMISSION_RATE=0.025

# API Key (bots will use this)
API_KEY=pb_dev_your_secret_key

# Server
PORT=3000
```

### 3. Deploy

```bash
docker compose up -d
```

### 4. Verify

```bash
curl http://localhost:3000/health
# Response: { "status": "ok", "version": "0.2.0" }
```

### 5. Configure your bot

```typescript
import { PayBotClient } from 'paybot-sdk';

const client = new PayBotClient({
  apiKey: 'pb_dev_your_secret_key',    // Match your .env
  botId: 'my-bot',
  facilitatorUrl: 'http://localhost:3000',  // Your instance
});

await client.register();
await client.pay({
  resource: 'https://api.example.com/data',
  amount: '0.01',
  payTo: '0x1234...abcd',
});
```

---

## Configuration

See [paybot-core DEPLOYMENT.md](https://github.com/RBKunnela/paybot-core/blob/main/DEPLOYMENT.md) for:
- Complete environment variable reference
- Production setup
- Monitoring & troubleshooting
- Multiple network support

---

## When to Self-Host

✅ **Self-host if you:**
- Need custom blockchain networks
- Have compliance requirements
- Want full control over settlement
- Run high-volume bots (enterprise tier)

❌ **Use hosted (api.paybotcore.com) if you:**
- Want zero setup
- Are testing or prototyping
- Don't need custom networks
- Prefer managed service

---

## Data Persistence

Docker volume `paybot-data` persists your database:

```bash
# View volumes
docker volume ls | grep paybot

# Backup database
docker compose exec paybot cp /app/data/paybot.db /app/data/paybot.db.backup
```

---

## Troubleshooting

**Port 3000 already in use?**
```env
PORT=3001
```

**Container won't start?**
```bash
docker compose logs paybot
```

**Reset everything?**
```bash
docker compose down -v
docker compose up -d
```

---

For full documentation, see [paybot-core DEPLOYMENT.md](https://github.com/RBKunnela/paybot-core/blob/main/DEPLOYMENT.md)
