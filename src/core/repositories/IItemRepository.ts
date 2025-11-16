/**
 * Item repository interface - defines contract for item data access
 * Pure interface, no implementation details
 */

import { Item, ItemId, ItemType, ItemTag } from '../entities/Item';
import { UserId } from '../entities/User';

/**
 * Search filters for finding items
 */
export interface SearchFilters {
  type?: ItemType;
  status?: 'WANT_TO_READ' | 'READING' | 'READ' | 'SKIMMED';
  author?: string;
  tags?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  hasRating?: boolean;
  minRating?: number;
  maxRating?: number;
  isPublic?: boolean;
}

/**
 * Pagination options for item queries
 */
export interface ItemPaginationOptions {
  limit: number;
  cursor?: string;
}

/**
 * Sort options for item queries
 */
export interface ItemSortOptions {
  field: 'addedAt' | 'readDate' | 'title' | 'author' | 'viewCount';
  direction: 'asc' | 'desc';
}

/**
 * Item repository interface
 * Implements repository pattern to abstract data access
 */
export interface IItemRepository {
  /**
   * Create a new item
   * @param item Item entity to create
   * @returns Promise that resolves when creation is complete
   */
  create(item: Item): Promise<void>;

  /**
   * Find item by ID
   * @param id Item ID to search for
   * @returns Item if found, null if not found
   */
  findById(id: ItemId): Promise<Item | null>;

  /**
   * Find items by user ID with pagination
   * @param userId User ID to search for
   * @param options Pagination and filtering options
   * @returns Items with pagination info
   */
  findByUserId(
    userId: UserId,
    options: ItemPaginationOptions & {
      filters?: SearchFilters;
      sort?: ItemSortOptions;
    }
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }>;

  /**
   * Search items within a user's collection using full-text search
   * @param userId User ID to search within
   * @param query Search query string
   * @param options Additional options
   * @returns Matching items with pagination info
   */
  search(
    userId: UserId,
    query: string,
    options?: {
      filters?: Omit<SearchFilters, 'dateRange'>; // Exclude dateRange for search
      sort?: ItemSortOptions;
      limit?: number;
      cursor?: string;
    }
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
    total?: number;
  }>;

  /**
   * Update an existing item
   * @param id Item ID to update
   * @param updates Partial item data to update
   * @returns Promise that resolves when update is complete
   * @throws NotFoundError if item doesn't exist
   */
  update(id: ItemId, updates: {
    title?: string;
    author?: string;
    url?: string;
    coverImage?: string;
    publishedYear?: number;
    status?: 'WANT_TO_READ' | 'READING' | 'READ' | 'SKIMMED';
    rating?: number;
    notes?: string;
    readDate?: Date;
    isPublic?: boolean;
    tags?: ItemTag[];
    metadata?: Record<string, any>;
  }): Promise<void>;

  /**
   * Delete an item
   * @param id Item ID to delete
   * @returns Promise that resolves when deletion is complete
   * @throws NotFoundError if item doesn't exist
   */
  delete(id: ItemId): Promise<void>;

  /**
   * Get items by type for a user
   * @param userId User ID to search for
   * @param type Item type to filter by
   * @param options Pagination options
   * @returns Items with pagination info
   */
  findByType(
    userId: UserId,
    type: ItemType,
    options: ItemPaginationOptions
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }>;

  /**
   * Get items with specific tags
   * @param userId User ID to search for
   * @param tagIds Tag IDs to filter by
   * @param options Pagination options
   * @returns Items with pagination info
   */
  findByTags(
    userId: UserId,
    tagIds: string[],
    options: ItemPaginationOptions
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }>;

  /**
   * Get recently added items for a user
   * @param userId User ID to search for
   * @param limit Maximum number of items to return
   * @returns Recently added items
   */
  findRecent(userId: UserId, limit: number): Promise<Item[]>;

  /**
   * Get items read in a specific date range
   * @param userId User ID to search for
   * @param startDate Start of date range
   * @param endDate End of date range
   * @param options Pagination options
   * @returns Items with pagination info
   */
  findByReadDateRange(
    userId: UserId,
    startDate: Date,
    endDate: Date,
    options?: ItemPaginationOptions
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }>;

  /**
   * Increment view count for an item
   * @param id Item ID to update
   * @returns Promise that resolves when update is complete
   */
  incrementViewCount(id: ItemId): Promise<void>;

  /**
   * Find public items for discovery (across all users)
   * @param options Pagination and filtering options
   * @returns Public items with pagination info
   */
  findPublicItems(
    options: ItemPaginationOptions & {
      filters?: Omit<SearchFilters, 'isPublic'>; // Exclude isPublic since we're only getting public items
      sort?: ItemSortOptions;
    }
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }>;

  /**
   * Search across all users' public items
   * @param query Search query string
   * @param options Additional options
   * @returns Matching items with pagination info
   */
  searchPublic(
    query: string,
    options?: {
      filters?: Omit<SearchFilters, 'isPublic'> & { dateRange?: { start: Date; end: Date } };
      sort?: ItemSortOptions;
      limit?: number;
      cursor?: string;
    }
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
    total?: number;
  }>;

  /**
   * Count items for a user
   * @param userId User ID to count for
   * @param filters Optional filters to apply
   * @returns Total count of items
   */
  countByUser(
    userId: UserId,
    filters?: SearchFilters
  ): Promise<number>;

  /**
   * Get count of items by type for a user
   * @param userId User ID to count for
   * @returns Count by type
   */
  countByType(userId: UserId): Promise<{
    books: number;
    papers: number;
    articles: number;
    total: number;
  }>;

  /**
   * Get batch of items for background processing
   * @param options Batch processing options
   * @returns Batch of items
   */
  getBatchForProcessing(
    options: { limit: number; cursor?: string }
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }>;

  /**
   * Find items that need metadata fetching
   * @param options Pagination options
   * @returns Items needing metadata
   */
  findItemsNeedingMetadata(
    options?: ItemPaginationOptions
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }>;

  /**
   * Mark item as having failed metadata fetch
   * @param id Item ID to mark
   * @param error Error message
   * @returns Promise that resolves when update is complete
   */
  markMetadataFetchFailed(id: ItemId, error: string): Promise<void>;

  /**
   * Update item tags
   * @param itemId Item ID to update
   * @param tags New tag list
   * @returns Promise that resolves when update is complete
   */
  updateTags(itemId: ItemId, tags: ItemTag[]): Promise<void>;
}

/**
 * Test double for unit testing
 * In-memory implementation for development and testing
 */
export class MockItemRepository implements IItemRepository {
  private items = new Map<string, Item>();
  private userItemsIndex = new Map<string, Set<string>>(); // userId -> Set of itemIds
  private titleIndex = new Map<string, Set<string>>(); // normalizedTitle -> Set of itemIds
  private authorIndex = new Map<string, Set<string>>(); // normalizedAuthor -> Set of itemIds

  async create(item: Item): Promise<void> {
    // Add to storage
    this.items.set(item.getId(), item);
    
    // Add to user index
    if (!this.userItemsIndex.has(item.getUserId())) {
      this.userItemsIndex.set(item.getUserId(), new Set());
    }
    this.userItemsIndex.get(item.getUserId())!.add(item.getId());
    
    // Add to search indexes
    const normalizedTitle = item.getTitle().toLowerCase();
    if (!this.titleIndex.has(normalizedTitle)) {
      this.titleIndex.set(normalizedTitle, new Set());
    }
    this.titleIndex.get(normalizedTitle)!.add(item.getId());
    
    if (item.getAuthor()) {
      const normalizedAuthor = item.getAuthor()!.toLowerCase();
      if (!this.authorIndex.has(normalizedAuthor)) {
        this.authorIndex.set(normalizedAuthor, new Set());
      }
      this.authorIndex.get(normalizedAuthor)!.add(item.getId());
    }

    // Simulate realistic latency
    await new Promise(resolve => setTimeout(resolve, Math.random() * 20 + 10));
  }

  async findById(id: ItemId): Promise<Item | null> {
    await new Promise(resolve => setTimeout(resolve, Math.random() * 5 + 2));
    return this.items.get(id) || null;
  }

  async findByUserId(
    userId: UserId,
    options: ItemPaginationOptions & {
      filters?: SearchFilters;
      sort?: ItemSortOptions;
    }
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
  }> {
    let items = this.getItemsByUser(userId);
    
    // Apply filters
    if (options.filters) {
      items = this.applyFilters(items, options.filters);
    }
    
    // Apply sorting
    if (options.sort) {
      items = this.applySorting(items, options.sort);
    } else {
      // Default sort: addedAt desc
      items.sort((a, b) => b.getAddedAt().getTime() - a.getAddedAt().getTime());
    }
    
    // Apply pagination
    const startIndex = options.cursor ? 
      items.findIndex(item => item.getId() === options.cursor) + 1 : 0;
    
    const paginatedItems = items.slice(startIndex, startIndex + options.limit);
    const nextCursor = items.length > startIndex + options.limit ? 
      paginatedItems[paginatedItems.length - 1].getId() : null;

    return {
      items: paginatedItems,
      nextCursor
    };
  }

  async search(
    userId: UserId,
    query: string,
    options?: {
      filters?: Omit<SearchFilters, 'dateRange'>;
      sort?: ItemSortOptions;
      limit?: number;
      cursor?: string;
    }
  ): Promise<{
    items: Item[];
    nextCursor: string | null;
    total?: number;
  }> {
    // Get user's items
    let items = this.getItemsByUser(userId);
    
    // Apply text search (simplified)
    const queryLower = query.toLowerCase();
    items = items.filter(item => 
      item.getTitle().toLowerCase().includes(queryLower) ||
      (item.getAuthor() && item.getAuthor()!.toLowerCase().includes(queryLower)) ||
      item.getNotes()?.toLowerCase().includes(queryLower) ||
      item.getTags().some(tag => tag.name.toLowerCase().includes(queryLower))
    );
    
    // Apply additional filters
    if (options?.filters) {
      items = this.applyFilters(items, options.filters as SearchFilters);
    }
    
    // Apply sorting (relevance-based for search)
    if (options?.sort) {
      items = this.applySorting(items, options.sort);
    } else {
      // Default: relevance-based sort (simplified)
      items.sort((a, b) => {
        const aRelevance = this.calculateRelevance(a, queryLower);
        const bRelevance = this.calculateRelevance(b, queryLower);
        return bRelevance - aRelevance;
      });
    }
    
    const total = items.length;
    const limit = options?.limit || 20;
    const cursor = options?.cursor;
    
    // Apply pagination
    const startIndex = cursor ? 
      items.findIndex(item => item.getId() === cursor) + 1 : 0;
    
    const paginatedItems = items.slice(startIndex, startIndex + limit);
    const nextCursor = items.length > startIndex + limit ? 
      paginatedItems[paginatedItems.length - 1].getId() : null;

    return {
      items: paginatedItems,
      nextCursor,
      total
    };
  }

  async update(id: ItemId, updates: any): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error('Item not found');
    
    // Update the item (simplified for mock)
    const updatedItem = item.update(updates);
    this.items.set(id, updatedItem);
  }

  async delete(id: ItemId): Promise<void> {
    const item = this.items.get(id);
    if (!item) throw new Error('Item not found');
    
    // Remove from all indexes
    this.items.delete(id);
    
    const userItems = this.userItemsIndex.get(item.getUserId());
    if (userItems) {
      userItems.delete(id);
      if (userItems.size === 0) {
        this.userItemsIndex.delete(item.getUserId());
      }
    }
    
    // Simulate latency
    await new Promise(resolve => setTimeout(resolve, Math.random() * 10 + 5));
  }

  async findByType(userId: UserId, type: ItemType, options: ItemPaginationOptions): Promise<{
    items: Item[];
    nextCursor: string | null;
  }> {
    const result = await this.findByUserId(userId, { ...options, filters: { type } });
    return result;
  }

  async findByTags(userId: UserId, tagIds: string[], options: ItemPaginationOptions): Promise<{
    items: Item[];
    nextCursor: string | null;
  }> {
    const userItems = this.getItemsByUser(userId);
    const itemsWithTags = userItems.filter(item => 
      item.getTags().some(tag => tagIds.includes(tag.id))
    );
    
    // Apply pagination
    const startIndex = options.cursor ? 
      itemsWithTags.findIndex(item => item.getId() === options.cursor) + 1 : 0;
    
    const paginatedItems = itemsWithTags.slice(startIndex, startIndex + options.limit);
    const nextCursor = itemsWithTags.length > startIndex + options.limit ? 
      paginatedItems[paginatedItems.length - 1].getId() : null;

    return {
      items: paginatedItems,
      nextCursor
    };
  }

  async findRecent(userId: UserId, limit: number): Promise<Item[]> {
    const userItems = this.getItemsByUser(userId);
    return userItems
      .sort((a, b) => b.getAddedAt().getTime() - a.getAddedAt().getTime())
      .slice(0, limit);
  }

  async findByReadDateRange(userId: UserId, startDate: Date, endDate: Date, options?: ItemPaginationOptions): Promise<{
    items: Item[];
    nextCursor: string | null;
  }> {
    const userItems = this.getItemsByUser(userId);
    const itemsInRange = userItems.filter(item => {
      const readDate = item.getReadDate();
      return readDate && readDate >= startDate && readDate <= endDate;
    });
    
    // Sort by read date desc
    itemsInRange.sort((a, b) => 
      (b.getReadDate()?.getTime() || 0) - (a.getReadDate()?.getTime() || 0)
    );
    
    const limit = options?.limit || 20;
    const startIndex = options?.cursor ? 
      itemsInRange.findIndex(item => item.getId() === options.cursor) + 1 : 0;
    
    const paginatedItems = itemsInRange.slice(startIndex, startIndex + limit);
    const nextCursor = itemsInRange.length > startIndex + limit ? 
      paginatedItems[paginatedItems.length - 1].getId() : null;

    return {
      items: paginatedItems,
      nextCursor
    };
  }

  async incrementViewCount(id: ItemId): Promise<void> {
    const item = this.items.get(id);
    if (item) {
      const updatedItem = item.incrementViewCount();
      this.items.set(id, updatedItem);
    }
  }

  async findPublicItems(options: ItemPaginationOptions & {
    filters?: Omit<SearchFilters, 'isPublic'>;
    sort?: ItemSortOptions;
  }): Promise<{
    items: Item[];
    nextCursor: string | null;
  }> {
    // Mock implementation - get all public items
    const allItems = Array.from(this.items.values()).filter(item => item.getIsPublic());
    
    // Apply filters
    let filteredItems = allItems;
    if (options.filters) {
      filteredItems = this.applyFilters(filteredItems, { ...options.filters, isPublic: true });
    }
    
    // Apply sorting
    if (options.sort) {
      filteredItems = this.applySorting(filteredItems, options.sort);
    } else {
      filteredItems.sort((a, b) => b.getAddedAt().getTime() - a.getAddedAt().getTime());
    }
    
    // Apply pagination
    const startIndex = options.cursor ? 
      filteredItems.findIndex(item => item.getId() === options.cursor) + 1 : 0;
    
    const paginatedItems = filteredItems.slice(startIndex, startIndex + options.limit);
    const nextCursor = filteredItems.length > startIndex + options.limit ? 
      paginatedItems[paginatedItems.length - 1].getId() : null;

    return {
      items: paginatedItems,
      nextCursor
    };
  }

  async searchPublic(query: string, options?: any): Promise<{
    items: Item[];
    nextCursor: string | null;
    total?: number;
  }> {
    // Mock implementation - search across all public items
    const queryLower = query.toLowerCase();
    const allPublicItems = Array.from(this.items.values()).filter(item => item.getIsPublic());
    
    const matchingItems = allPublicItems.filter(item => 
      item.getTitle().toLowerCase().includes(queryLower) ||
      (item.getAuthor() && item.getAuthor()!.toLowerCase().includes(queryLower))
    );
    
    return {
      items: matchingItems.slice(0, options?.limit || 20),
      nextCursor: null,
      total: matchingItems.length
    };
  }

  async countByUser(userId: UserId, filters?: SearchFilters): Promise<number> {
    let items = this.getItemsByUser(userId);
    if (filters) {
      items = this.applyFilters(items, filters);
    }
    return items.length;
  }

  async countByType(userId: UserId): Promise<{
    books: number;
    papers: number;
    articles: number;
    total: number;
  }> {
    const items = this.getItemsByUser(userId);
    return {
      books: items.filter(item => item.getType() === 'BOOK').length,
      papers: items.filter(item => item.getType() === 'PAPER').length,
      articles: items.filter(item => item.getType() === 'ARTICLE').length,
      total: items.length
    };
  }

  async getBatchForProcessing(options: { limit: number; cursor?: string; }): Promise<{
    items: Item[];
    nextCursor: string | null;
  }> {
    // Mock implementation
    return { items: [], nextCursor: null };
  }

  async findItemsNeedingMetadata(options?: ItemPaginationOptions): Promise<{
    items: Item[];
    nextCursor: string | null;
  }> {
    // Mock implementation
    return { items: [], nextCursor: null };
  }

  async markMetadataFetchFailed(id: ItemId, error: string): Promise<void> {
    // Mock implementation
  }

  async updateTags(itemId: ItemId, tags: ItemTag[]): Promise<void> {
    // Mock implementation
  }

  // Helper methods
  private getItemsByUser(userId: UserId): Item[] {
    const itemIds = this.userItemsIndex.get(userId) || new Set();
    return Array.from(itemIds).map(id => this.items.get(id)).filter(Boolean) as Item[];
  }

  private applyFilters(items: Item[], filters: SearchFilters): Item[] {
    return items.filter(item => {
      if (filters.type && item.getType() !== filters.type) return false;
      if (filters.status && item.getStatus() !== filters.status) return false;
      if (filters.author && (!item.getAuthor() || !item.getAuthor()!.toLowerCase().includes(filters.author.toLowerCase()))) return false;
      if (filters.tags && !filters.tags.some(tagName => item.getTags().some(tag => tag.name === tagName))) return false;
      if (filters.hasRating && item.getRating() === undefined) return false;
      if (filters.minRating && (item.getRating() === undefined || item.getRating()! < filters.minRating)) return false;
      if (filters.maxRating && (item.getRating() === undefined || item.getRating()! > filters.maxRating)) return false;
      if (filters.isPublic !== undefined && item.getIsPublic() !== filters.isPublic) return false;
      
      if (filters.dateRange) {
        const readDate = item.getReadDate();
        if (!readDate || readDate < filters.dateRange.start || readDate > filters.dateRange.end) {
          return false;
        }
      }
      
      return true;
    });
  }

  private applySorting(items: Item[], sort: ItemSortOptions): Item[] {
    return items.sort((a, b) => {
      let aValue: any, bValue: any;
      
      switch (sort.field) {
        case 'title':
          aValue = a.getTitle();
          bValue = b.getTitle();
          break;
        case 'author':
          aValue = a.getAuthor() || '';
          bValue = b.getAuthor() || '';
          break;
        case 'addedAt':
          aValue = a.getAddedAt().getTime();
          bValue = b.getAddedAt().getTime();
          break;
        case 'readDate':
          aValue = a.getReadDate()?.getTime() || 0;
          bValue = b.getReadDate()?.getTime() || 0;
          break;
        case 'viewCount':
          aValue = a.getViewCount();
          bValue = b.getViewCount();
          break;
        default:
          return 0;
      }
      
      if (sort.direction === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });
  }

  private calculateRelevance(item: Item, query: string): number {
    let score = 0;
    
    const title = item.getTitle().toLowerCase();
    const author = item.getAuthor()?.toLowerCase() || '';
    const notes = item.getNotes()?.toLowerCase() || '';
    
    if (title.includes(query)) score += 10;
    if (author.includes(query)) score += 5;
    if (notes.includes(query)) score += 2;
    
    return score;
  }
}
