/**
 * Pure TypeScript Item entity representing a reading item (book, paper, article)
 * Zero external dependencies - pure domain logic
 */

import { UserId } from './User';

// Value objects
export type ItemId = string & { readonly __brand: 'ItemId' };
export type TagId = string & { readonly __brand: 'TagId' };

// Create branded types
function brand<T extends string>(value: T): T & { readonly __brand: T } {
  return value as T & { readonly __brand: T };
}

// Enums matching Prisma schema
export enum ItemType {
  BOOK = 'BOOK',
  PAPER = 'PAPER',
  ARTICLE = 'ARTICLE'
}

export enum ReadingStatus {
  WANT_TO_READ = 'WANT_TO_READ',
  READING = 'READING',
  READ = 'READ',
  SKIMMED = 'SKIMMED'
}

// Type-specific metadata interface
export interface ItemMetadata {
  isbn?: string;
  doi?: string;
  journal?: string;
  publisher?: string;
  pages?: string;
  volume?: string;
  issue?: string;
  arxivId?: string;
  source?: string;
  originalUrl?: string;
  [key: string]: any;
}

// Tag interface
export interface ItemTag {
  id: TagId;
  name: string;
  slug: string;
  color: string;
}

/**
 * Item entity representing a reading item
 */
export class Item {
  private constructor(
    private readonly id: ItemId,
    private readonly userId: UserId,
    private readonly type: ItemType,
    private readonly title: string,
    private readonly author?: string,
    private readonly url?: string,
    private readonly coverImage?: string,
    private readonly publishedYear?: number,
    private readonly status: ReadingStatus = ReadingStatus.READ,
    private readonly rating?: number,
    private readonly notes?: string,
    private readonly readDate?: Date,
    private readonly isPublic: boolean = true,
    private readonly viewCount: number = 0,
    private readonly tags: ItemTag[] = [],
    private readonly metadata: ItemMetadata = {},
    private readonly addedAt: Date = new Date(),
    private readonly updatedAt: Date = new Date()
  ) {}

  /**
   * Create a new Item instance with validation
   */
  static create(input: {
    id?: string;
    userId: UserId;
    type: ItemType;
    title: string;
    author?: string;
    url?: string;
    coverImage?: string;
    publishedYear?: number;
    status?: ReadingStatus;
    rating?: number;
    notes?: string;
    readDate?: Date;
    isPublic?: boolean;
    tags?: ItemTag[];
    metadata?: ItemMetadata;
  }): Item {
    // Validate required fields
    if (!input.title || input.title.trim().length === 0) {
      throw new Error('Title is required');
    }

    if (input.title.length > 500) {
      throw new Error('Title cannot exceed 500 characters');
    }

    // Validate author if provided
    if (input.author && input.author.length > 500) {
      throw new Error('Author cannot exceed 500 characters');
    }

    // Validate URL if provided
    if (input.url) {
      try {
        new URL(input.url);
      } catch {
        throw new Error('Invalid URL format');
      }
    }

    // Validate rating if provided
    if (input.rating !== undefined) {
      if (input.rating < 1 || input.rating > 5) {
        throw new Error('Rating must be between 1 and 5');
      }
    }

    // Validate notes if provided
    if (input.notes && input.notes.length > 5000) {
      throw new Error('Notes cannot exceed 5000 characters');
    }

    // Validate published year
    if (input.publishedYear !== undefined) {
      const currentYear = new Date().getFullYear();
      if (input.publishedYear < 1400 || input.publishedYear > currentYear + 1) {
        throw new Error(`Published year must be between 1400 and ${currentYear + 1}`);
      }
    }

    // Validate tags
    if (input.tags && input.tags.length > 10) {
      throw new Error('Cannot have more than 10 tags');
    }

    const itemId = input.id ? brand(input.id) : brand(crypto.randomUUID());

    return new Item(
      itemId,
      input.userId,
      input.type,
      input.title.trim(),
      input.author?.trim(),
      input.url,
      input.coverImage,
      input.publishedYear,
      input.status || ReadingStatus.READ,
      input.rating,
      input.notes?.trim(),
      input.readDate,
      input.isPublic !== false, // Default to true
      0, // viewCount starts at 0
      input.tags || [],
      input.metadata || {},
      new Date(),
      new Date()
    );
  }

  // Getters
  getId(): ItemId {
    return this.id;
  }

  getUserId(): UserId {
    return this.userId;
  }

  getType(): ItemType {
    return this.type;
  }

  getTitle(): string {
    return this.title;
  }

  getAuthor(): string | undefined {
    return this.author;
  }

  getUrl(): string | undefined {
    return this.url;
  }

  getCoverImage(): string | undefined {
    return this.coverImage;
  }

  getPublishedYear(): number | undefined {
    return this.publishedYear;
  }

  getStatus(): ReadingStatus {
    return this.status;
  }

  getRating(): number | undefined {
    return this.rating;
  }

  getNotes(): string | undefined {
    return this.notes;
  }

  getReadDate(): Date | undefined {
    return this.readDate;
  }

  getIsPublic(): boolean {
    return this.isPublic;
  }

  getViewCount(): number {
    return this.viewCount;
  }

  getTags(): ReadonlyArray<ItemTag> {
    return [...this.tags];
  }

  getMetadata(): Readonly<ItemMetadata> {
    return { ...this.metadata };
  }

  getAddedAt(): Date {
    return this.addedAt;
  }

  getUpdatedAt(): Date {
    return this.updatedAt;
  }

  /**
   * Check if this item belongs to the given user
   */
  belongsToUser(userId: UserId): boolean {
    return this.userId === userId;
  }

  /**
   * Check if the item can be viewed by the given user
   */
  canBeViewedBy(userId: UserId | null): boolean {
    return this.isPublic || (userId !== null && this.belongsToUser(userId));
  }

  /**
   * Check if the item is a book
   */
  isBook(): boolean {
    return this.type === ItemType.BOOK;
  }

  /**
   * Check if the item is a paper
   */
  isPaper(): boolean {
    return this.type === ItemType.PAPER;
  }

  /**
   * Check if the item is an article
   */
  isArticle(): boolean {
    return this.type === ItemType.ARTICLE;
  }

  /**
   * Check if the item has been read
   */
  hasBeenRead(): boolean {
    return this.status === ReadingStatus.READ || this.status === ReadingStatus.SKIMMED;
  }

  /**
   * Check if the item is currently being read
   */
  isBeingRead(): boolean {
    return this.status === ReadingStatus.READING;
  }

  /**
   * Check if the item is on the reading list
   */
  isOnReadingList(): boolean {
    return this.status === ReadingStatus.WANT_TO_READ;
  }

  /**
   * Get display title (title + subtitle if available)
   */
  getDisplayTitle(): string {
    return this.metadata.subtitle 
      ? `${this.title}: ${this.metadata.subtitle}`
      : this.title;
  }

  /**
   * Get author display (handle multiple authors)
   */
  getAuthorDisplay(): string | undefined {
    if (!this.author) return undefined;
    
    // Handle multiple authors separated by commas
    const authors = this.author.split(',').map(a => a.trim());
    if (authors.length === 1) {
      return authors[0];
    } else if (authors.length === 2) {
      return `${authors[0]} and ${authors[1]}`;
    } else {
      return `${authors[0]} et al.`;
    }
  }

  /**
   * Update the item with new data
   */
  update(updates: {
    title?: string;
    author?: string;
    url?: string;
    coverImage?: string;
    publishedYear?: number;
    status?: ReadingStatus;
    rating?: number;
    notes?: string;
    readDate?: Date;
    isPublic?: boolean;
    tags?: ItemTag[];
    metadata?: Partial<ItemMetadata>;
  }): Item {
    const updatedMetadata = updates.metadata 
      ? { ...this.metadata, ...updates.metadata }
      : this.metadata;

    return new Item(
      this.id,
      this.userId,
      this.type,
      updates.title?.trim() || this.title,
      updates.author?.trim() || this.author,
      updates.url || this.url,
      updates.coverImage || this.coverImage,
      updates.publishedYear !== undefined ? updates.publishedYear : this.publishedYear,
      updates.status || this.status,
      updates.rating !== undefined ? updates.rating : this.rating,
      updates.notes?.trim() || this.notes,
      updates.readDate !== undefined ? updates.readDate : this.readDate,
      updates.isPublic !== undefined ? updates.isPublic : this.isPublic,
      this.viewCount,
      updates.tags || this.tags,
      updatedMetadata,
      this.addedAt,
      new Date()
    );
  }

  /**
   * Increment view count
   */
  incrementViewCount(): Item {
    return new Item(
      this.id,
      this.userId,
      this.type,
      this.title,
      this.author,
      this.url,
      this.coverImage,
      this.publishedYear,
      this.status,
      this.rating,
      this.notes,
      this.readDate,
      this.isPublic,
      this.viewCount + 1,
      this.tags,
      this.metadata,
      this.addedAt,
      new Date()
    );
  }

  /**
   * Update rating
   */
  updateRating(rating: number): Item {
    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    return new Item(
      this.id,
      this.userId,
      this.type,
      this.title,
      this.author,
      this.url,
      this.coverImage,
      this.publishedYear,
      this.status,
      rating,
      this.notes,
      this.readDate,
      this.isPublic,
      this.viewCount,
      this.tags,
      this.metadata,
      this.addedAt,
      new Date()
    );
  }

  /**
   * Convert to plain object for DTOs and persistence
   */
  toPlainObject(): {
    id: string;
    userId: string;
    type: ItemType;
    title: string;
    author?: string;
    url?: string;
    coverImage?: string;
    publishedYear?: number;
    status: ReadingStatus;
    rating?: number;
    notes?: string;
    readDate?: Date;
    isPublic: boolean;
    viewCount: number;
    tags: ItemTag[];
    metadata: ItemMetadata;
    addedAt: Date;
    updatedAt: Date;
  } {
    return {
      id: this.id,
      userId: this.userId,
      type: this.type,
      title: this.title,
      author: this.author,
      url: this.url,
      coverImage: this.coverImage,
      publishedYear: this.publishedYear,
      status: this.status,
      rating: this.rating,
      notes: this.notes,
      readDate: this.readDate,
      isPublic: this.isPublic,
      viewCount: this.viewCount,
      tags: this.tags,
      metadata: this.metadata,
      addedAt: this.addedAt,
      updatedAt: this.updatedAt
    };
  }
}
