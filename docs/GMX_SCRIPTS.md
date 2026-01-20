## GMX v2 EOA Scripts (Arbitrum)

These scripts open/close and inspect GMX v2 ETH shorts using an EOA on Arbitrum.
They assume a local `.env` with `PRIVATE_KEY` and `ARBITRUM_RPC_URL` configured.

### Create short (USDC collateral)

Creates a MarketIncrease short using USDC collateral.
`acceptablePrice` uses 12-decimal pricing with 1% slippage.

```
npx hardhat run scripts/create-short-position.ts --network arbitrum
```

### Close short

Closes the full ETH short using MarketDecrease with 1% slippage.

```
npx hardhat run scripts/close-short-position.ts --network arbitrum
```

### Read current positions

Lists current GMX positions for the account via Reader.

```
MARKET=0x70d95587d40A2caf56bd97485aB3Eec10Bee6336 \
  npx hardhat run scripts/read-positions.ts --network arbitrum
```

### Read a specific order (from tx or order key)

Parses EventEmitter logs for a tx to get `orderKey` and `acceptablePrice`,
then reads the order (if still present) from the Reader.

```
TX_HASH=0x... npx hardhat run scripts/read-order.ts --network arbitrum
# or
ORDER_KEY=0x... npx hardhat run scripts/read-order.ts --network arbitrum
```

### Scan recent order events

Scans `OrderCreated` events from the EventEmitter and prints acceptable price
in multiple decimal scales. Use small ranges to avoid RPC limits.

```
BLOCKS_BACK=200 npx hardhat run scripts/scan-order-events.ts --network arbitrum
```

### Helper balance scripts

```
npx hardhat run scripts/check-balance.ts --network arbitrum
npx hardhat run scripts/check-usdc.ts --network arbitrum
```

### Notes

- GMX `acceptablePrice` in `OrderCreated` logs is 12-decimal scaled.
- The script uses Chainlink ETH/USD (8 decimals) and converts to 12 decimals
  before applying slippage.
- Orders can disappear from Reader after execution/cancel; use EventEmitter
  logs to inspect historical orders.
