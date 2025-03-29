import path from 'path';
import { addEventToRSS, updateRSSFeed } from "../rss/utils";
import { ethereumConfig, zkSyncConfig } from "../shared/constants";
import dotenv from 'dotenv';
import { convertBigIntToString } from "../shared/utils";
import { monitorEventsAtBlock } from "../shared/getEventsAtBlock";
import type { NetworkConfig } from "../shared/types";

// Configuration
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function processSpecificBlocks(networkName: string, blockNumbers: number[]) {
  const config = networkName === 'ethereum' ? ethereumConfig : zkSyncConfig;
  const provider = config.provider;
  let foundEvents = false;

  for (const blockNumber of blockNumbers) {
    const block = await provider.getBlock(blockNumber);
    if (!block) continue;

    const events = await monitorEventsAtBlock(
      blockNumber,
      provider,
      config.eventsMapping
    );

    if (events.length > 0) {
      foundEvents = true;
      for (const event of events) {
        await addEventToRSS(
          event.address,
          event.eventName,
          event.topics,
          event.title,
          event.link,
          networkName === 'ethereum' ? 'Ethereum Mainnet' : networkName,
          Number(event.chainId),
          blockNumber,
          config.governanceName,
          event.proposalLink || null,
          String(block.timestamp),
          convertBigIntToString(event.args)
        );
      }
    }
  }

  if (foundEvents) {
    await updateRSSFeed();
  }
}

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

// Handle CLI arguments if script is called directly
if (require.main === module) {
  const network = process.argv[2];
  const blocks = process.argv.slice(3).map(Number);

  if (!network || blocks.length === 0) {
    throw new Error('Usage: npm run process-specific-blocks <network> <blockNumber1> <blockNumber2> ...');
  }

  processSpecificBlocks(network, blocks);
}

export { processSpecificBlocks };
