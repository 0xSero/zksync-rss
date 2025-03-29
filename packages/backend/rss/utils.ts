import RSS, { ItemOptions } from "rss";
import { ethers } from "ethers";
import { uploadToGCS, GCS_BUCKET_NAME, GCS_RSS_PATH, GCS_ARCHIVE_PATH, ARCHIVE_ITEM_THRESHOLD } from "~/shared";
import { Storage } from '@google-cloud/storage';
import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';

const CONFIG = {
  filePaths: {
    data: path.join(__dirname, '../data/rss-feed.json'),
    output: path.join(__dirname, '../data/feed.xml')
  },
  feed: {
    title: "ZKsync Governance Feed",
    description: "Monitor onchain ZKsync governance events",
    feed_url: "https://feed.zkNation.io/rss.xml",
    site_url: "https://feed.zkNation.io",
    language: 'en',
    managingEditor: 'admin@serotonindesigns.com',
    webMaster: 'admin@serotonindesigns.com',
    copyright: 'ZK Sync team',
    pubDate: new Date(),
  }
};

interface RSSWithItems extends RSS {
  items: ItemOptions[];
}

interface ParsedItem extends Parser.Item {
  contentSnippet?: string;
  description?: string;
  link?: string;
  creator?: string;
  author?: string;
  categories?: string[];
  isoDate?: string;
  pubDate?: string;
  id?: string;
}

class RSSFeedManager {
  private feed: RSS;
  private static instance: RSSFeedManager;
  private initialized = false;
  private seenGuids = new Set<string>();
  private items: ItemOptions[] = [];  // Track items separately for better sorting

  private constructor() {
    this.feed = new RSS(CONFIG.feed);
  }

  static getInstance(): RSSFeedManager {
    if (!RSSFeedManager.instance) {
      RSSFeedManager.instance = new RSSFeedManager();
    }
    return RSSFeedManager.instance;
  }

  async initialize() {
    if (!this.initialized) {
      await this.downloadExistingFeed();
      this.initialized = true;
    }
  }

  async downloadExistingFeed() {
    try {
      const storage = new Storage();
      const bucket = storage.bucket(GCS_BUCKET_NAME);

      // Get current feed
      const file = bucket.file(GCS_RSS_PATH);
      if ((await file.exists())[0]) {
        const [content] = await file.download();
        const result = await new Parser().parseString(content.toString());
        result.items?.forEach(item => this.addItemToFeed(item));
      }

      // Get archived items
      const [files] = await bucket.getFiles({ prefix: GCS_ARCHIVE_PATH });
      for (const file of files) {
        const [content] = await file.download();
        const result = await new Parser().parseString(content.toString());
        result.items?.forEach(item => this.addItemToFeed(item));
      }

      console.log(`Loaded ${this.seenGuids.size} unique items`);
    } catch (error) {
      console.error('Error downloading feed:', error);
      throw error;
    }
  }

  private addItemToFeed(item: ParsedItem) {
    const guid = item.guid || item.id;
    if (!guid) return;

    // Parse the description to get network name and other details
    let eventDetails;
    try {
      const description = JSON.parse(item.content || item.contentSnippet || '{}');
      eventDetails = description.eventDetails;
    } catch (e) {
      console.error('Failed to parse event details:', e);
      return;
    }

    // Normalize GUID components
    const normalizedNetworkName = (eventDetails?.network || '').toLowerCase().replace(/\s+/g, '');
    const normalizedTitle = (item.title || '').toLowerCase().replace(/\s+/g, '');
    const normalizedLink = (item.link || '').toLowerCase();
    const guidInput = `${normalizedNetworkName}-${eventDetails?.chainId || ''}-${normalizedTitle}-${eventDetails?.block || ''}-${normalizedLink}`;
    const normalizedGuid = ethers.keccak256(ethers.toUtf8Bytes(guidInput));

    if (!this.seenGuids.has(normalizedGuid)) {
      this.seenGuids.add(normalizedGuid);
      const newItem = {
        title: item.title || '',
        description: item.content || item.contentSnippet || '',
        url: item.link || '',
        guid: guid,
        categories: item.categories || [],
        author: item.creator || item.author || '',
        date: new Date(item.isoDate || item.pubDate || new Date())
      };

      // Get timestamp for sorting
      const timestamp = newItem.date.getTime();

      // Insert item in correct position to maintain sorted order
      const insertIndex = this.items.findIndex(existingItem => {
        const existingTimestamp = new Date(existingItem.date).getTime();
        return existingTimestamp < timestamp;
      });

      if (insertIndex === -1) {
        this.items.push(newItem);
      } else {
        this.items.splice(insertIndex, 0, newItem);
      }

      // Keep only the newest ARCHIVE_ITEM_THRESHOLD items in main feed
      if (this.items.length > ARCHIVE_ITEM_THRESHOLD) {
        const itemsToArchive = this.items.slice(ARCHIVE_ITEM_THRESHOLD);
        this.items = this.items.slice(0, ARCHIVE_ITEM_THRESHOLD);

        // Create archive feed for older items
        const archiveFeed = new RSS(CONFIG.feed);
        itemsToArchive.forEach(item => archiveFeed.item(item));

        // Upload archive asynchronously
        uploadToGCS(
          GCS_BUCKET_NAME,
          CONFIG.filePaths.output,
          `${GCS_ARCHIVE_PATH}/archive-${Date.now()}.xml`,
          archiveFeed.xml()
        ).catch(() => {});
      }
    }
  }

  addEvent(event: {
    address: string,
    eventName: string,
    topics: string[],
    title: string,
    link: string,
    networkName: string,
    chainId: number,
    block: number,
    govBody: string,
    proposalLink: string | null,
    timestamp: string,
    eventArgs: Record<string, unknown>
  }) {
    const normalizedNetworkName = event.networkName.toLowerCase().replace(/\s+/g, '');
    const normalizedTitle = event.title.toLowerCase().replace(/\s+/g, '');
    const normalizedLink = event.link.toLowerCase();
    const guidInput = `${normalizedNetworkName}-${event.chainId}-${normalizedTitle}-${event.block}-${normalizedLink}`;
    const guid = ethers.keccak256(ethers.toUtf8Bytes(guidInput));

    if (this.seenGuids.has(guid)) return;

    const unixTimestamp = Number(event.timestamp);
    if (isNaN(unixTimestamp)) return;

    const date = new Date(unixTimestamp * 1000);
    if (isNaN(date.getTime())) return;

    const newItem = {
      title: event.title,
      url: event.link,
      description: JSON.stringify({
        eventDetails: {
          network: event.networkName,
          chainId: event.chainId,
          block: event.block,
          timestamp: date.toLocaleString()
        },
        governanceInfo: {
          governanceBody: event.govBody,
          eventType: event.eventName,
          contractAddress: event.address,
          proposalLink: event.proposalLink
        },
        eventData: event.eventArgs
      }),
      author: event.govBody,
      categories: event.topics,
      date: date,
      guid,
    };

    const itemTimestamp = date.getTime();
    const insertIndex = this.items.findIndex(existingItem => {
      const existingTimestamp = new Date(existingItem.date).getTime();
      // If timestamps are equal, use block number as secondary sort key
      if (existingTimestamp === itemTimestamp) {
        const existingBlock = JSON.parse(existingItem.description).eventDetails.block;
        return existingBlock < event.block;
      }
      return existingTimestamp < itemTimestamp;
    });

    if (insertIndex === -1) {
      this.items.push(newItem);
    } else {
      this.items.splice(insertIndex, 0, newItem);
    }

    if (this.items.length > ARCHIVE_ITEM_THRESHOLD) {
      const itemsToArchive = this.items.slice(ARCHIVE_ITEM_THRESHOLD);
      this.items = this.items.slice(0, ARCHIVE_ITEM_THRESHOLD);

      const archiveFeed = new RSS(CONFIG.feed);
      itemsToArchive.forEach(item => archiveFeed.item(item));

      uploadToGCS(
        GCS_BUCKET_NAME,
        CONFIG.filePaths.output,
        `${GCS_ARCHIVE_PATH}/archive-${Date.now()}.xml`,
        archiveFeed.xml()
      ).catch(() => {});
    }
  }

  async generate(): Promise<RSS> {
    const sortedFeed = new RSS(CONFIG.feed);
    this.items.forEach(item => sortedFeed.item(item));
    return sortedFeed;
  }

  async upload(feed: RSS): Promise<boolean> {
    try {
      const rssContent = feed.xml();
      fs.mkdirSync(path.dirname(CONFIG.filePaths.output), { recursive: true });
      fs.writeFileSync(CONFIG.filePaths.output, rssContent);
      await uploadToGCS(GCS_BUCKET_NAME, CONFIG.filePaths.output, GCS_RSS_PATH, rssContent);
      return true;
    } catch {
      return false;
    }
  }

  async generateAndUpload(): Promise<boolean> {
    try {
      const feed = await this.generate();
      return await this.upload(feed);
    } catch {
      return false;
    }
  }
}

export const addEventToRSS = async (
  address: string,
  eventName: string,
  topics: string[],
  title: string,
  link: string,
  networkName: string,
  chainId: number,
  block: number,
  govBody: string,
  proposalLink: string | null,
  timestamp: string,
  eventArgs: Record<string, unknown>
) => {
  const manager = RSSFeedManager.getInstance();
  await manager.initialize();
  manager.addEvent({
    address, eventName, topics, title, link, networkName,
    chainId, block, govBody, proposalLink, timestamp, eventArgs
  });
};

export const updateRSSFeed = async () => {
  const manager = RSSFeedManager.getInstance();
  await manager.initialize();

  const feed = await manager.generate(); // Items are now sorted newest first
  const items = (feed as RSSWithItems).items;

  if (items.length > ARCHIVE_ITEM_THRESHOLD) {
    // Keep newest items in main feed
    const itemsToKeep = items.slice(0, ARCHIVE_ITEM_THRESHOLD);
    // Archive older items
    const itemsToArchive = items.slice(ARCHIVE_ITEM_THRESHOLD);

    // Create and upload archive of older items
    const archiveFeed = new RSS(CONFIG.feed);
    itemsToArchive.forEach(item => archiveFeed.item(item));
    await uploadToGCS(
      GCS_BUCKET_NAME,
      CONFIG.filePaths.output,
      `${GCS_ARCHIVE_PATH}/archive-${Date.now()}.xml`,
      archiveFeed.xml()
    );

    // Update main feed with newest items
    const newFeed = new RSS(CONFIG.feed);
    itemsToKeep.forEach(item => newFeed.item(item));
    return await manager.upload(newFeed);
  }

  return await manager.upload(feed);
};
